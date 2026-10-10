import type { CircuitJson } from "circuit-json"

const expectedNets = {
  "5V": ["J_POWER:V5V", "J_CAM_LEFT:V5V", "C_BULK:pin1", "C_DECOUPLE:pin1"],
  GND: ["J_POWER:GND", "J_CAM_LEFT:GND_LEFT", "J_CAM_RIGHT:GND_RIGHT", "J_CAM_RIGHT:GND_UART",
    "C_BULK:pin2", "C_DECOUPLE:pin2", "J_UART:GND", "J_BOOT:GND", "D_STATUS:pin2", "J_GPIO:GND"],
  "3V3": ["J_CAM_RIGHT:V3V3", "R_BOOT:pin1", "R_STATUS:pin1", "J_GPIO:V3V3"],
  UART_RX: ["J_CAM_RIGHT:CAM_RX", "J_UART:CAM_RX"],
  UART_TX: ["J_CAM_RIGHT:CAM_TX", "J_UART:CAM_TX"],
  BOOT: ["J_CAM_RIGHT:BOOT_IO0", "J_BOOT:BOOT_IO0", "R_BOOT:pin2"],
  STATUS_LED: ["R_STATUS:pin2", "D_STATUS:pin1"],
  GPIO12: ["J_CAM_LEFT:IO12", "J_GPIO:IO12"],
  GPIO13: ["J_CAM_LEFT:IO13", "J_GPIO:IO13"],
  GPIO14: ["J_CAM_LEFT:IO14", "J_GPIO:IO14"],
  GPIO15: ["J_CAM_LEFT:IO15", "J_GPIO:IO15"],
}
const expectedUnconnected = ["J_CAM_LEFT:IO2", "J_CAM_LEFT:IO4", "J_CAM_RIGHT:PSRAM_IO16", "J_CAM_RIGHT:VCC_LINK"]
const socketSignals = {
  J_CAM_LEFT: ["V5V", "GND_LEFT", "IO12", "IO13", "IO15", "IO14", "IO2", "IO4"],
  J_CAM_RIGHT: ["V3V3", "PSRAM_IO16", "BOOT_IO0", "GND_RIGHT", "VCC_LINK", "CAM_RX", "CAM_TX", "GND_UART"],
}
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Camera connectivity: ${message}`)
}
const equalSet = (a: Iterable<string>, b: Iterable<string>) => [...new Set(a)].sort().join("\n") === [...new Set(b)].sort().join("\n")

/** Check intended nets, actual PCB route endpoints, and the documented module interface. */
export function checkWifiCamera(circuit: CircuitJson) {
  const components = circuit.filter((element) => element.type === "source_component")
  const sourcePorts = circuit.filter((element) => element.type === "source_port")
  const pcbPorts = circuit.filter((element) => element.type === "pcb_port")
  const schematicPorts = circuit.filter((element) => element.type === "schematic_port")
  const sourceTraces = circuit.filter((element) => element.type === "source_trace")
  const pcbTraces = circuit.filter((element) => element.type === "pcb_trace")
  const sourceLabels = new Map(sourcePorts.map((port) => [port.source_port_id,
    `${components.find((component) => component.source_component_id === port.source_component_id)?.name}:${port.name}`]))
  const pcbLabels = new Map(pcbPorts.map((port) => [port.pcb_port_id, sourceLabels.get(port.source_port_id!)]))
  const endpoints = [...Object.values(expectedNets).flat(), ...expectedUnconnected]
  assert(sourcePorts.length === endpoints.length && equalSet(sourceLabels.values(), endpoints), "unexpected source endpoints")
  assert(pcbPorts.length === endpoints.length && equalSet([...pcbLabels.values()].map(String), endpoints), "unexpected PCB endpoints")
  assert(schematicPorts.length === sourcePorts.length && equalSet(schematicPorts.map((port) => port.source_port_id), sourcePorts.map((port) => port.source_port_id)),
    "schematic omitted source ports")
  const groups = new Map<string, Set<string>>()
  for (const trace of sourceTraces) {
    const key = trace.subcircuit_connectivity_map_key
    assert(key, "source trace has no connectivity group")
    const group = groups.get(key) ?? new Set<string>()
    for (const id of trace.connected_source_port_ids) group.add(sourceLabels.get(id)!)
    groups.set(key, group)
  }
  assert(groups.size === Object.keys(expectedNets).length, "unexpected source net count")
  for (const port of sourcePorts) {
    const label = sourceLabels.get(port.source_port_id)!
    if (expectedUnconnected.includes(label)) assert(!port.subcircuit_connectivity_map_key, `${label} should remain unconnected`)
    else assert(groups.get(port.subcircuit_connectivity_map_key!)?.has(label), `${label} disagrees with source traces`)
  }
  const edges = new Map<string, string[][]>()
  for (const trace of pcbTraces) {
    const connected = [...new Set(trace.route.flatMap((point) => point.route_type === "wire"
      ? [point.start_pcb_port_id, point.end_pcb_port_id].filter((id): id is string => !!id) : []))]
    assert(connected.length === 2, `${trace.pcb_trace_id} needs two endpoint ports`)
    const labels = connected.map((id) => pcbLabels.get(id)!)
    const matching = Object.entries(expectedNets).filter(([, wanted]) => labels.every((label) => wanted.includes(label)))
    assert(matching.length === 1, `${trace.pcb_trace_id} crosses source nets`)
    const physicalRefs = new Set<string>()
    for (const point of trace.route) {
      if (point.route_type !== "wire") continue
      for (const ref of [point.start_pcb_port_id, point.end_pcb_port_id]) {
        if (!ref) continue
        const port = pcbPorts.find((port) => port.pcb_port_id === ref)
        assert(port && connected.includes(ref), `${trace.pcb_trace_id} has an incorrect endpoint reference`)
        assert(Math.abs(port.x - point.x) < 1e-6 && Math.abs(port.y - point.y) < 1e-6,
          `${trace.pcb_trace_id} ends away from its referenced port`)
        physicalRefs.add(ref)
      }
    }
    assert(equalSet(physicalRefs, connected), `${trace.pcb_trace_id} is missing physical endpoints`)
    const name = matching[0]![0]
    edges.set(name, [...(edges.get(name) ?? []), labels])
  }
  const nets = Object.entries(expectedNets).map(([name, wanted]) => {
    assert([...groups.values()].some((group) => equalSet(group, wanted)), `${name} source wiring changed`)
    const routes = edges.get(name) ?? []
    const seen = new Set([wanted[0]!])
    let previous = 0
    while (seen.size !== previous) {
      previous = seen.size
      for (const edge of routes) if (edge.some((label) => seen.has(label))) edge.forEach((label) => seen.add(label))
    }
    assert(equalSet(seen, wanted), `${name} has unrouted endpoints`)
    return { name, endpoints: wanted, pcbRouteCount: routes.length, connected: true }
  })
  const socketPositions = Object.entries(socketSignals).flatMap(([name, signals]) => {
    const source = components.find((component) => component.name === name)
    const component = circuit.find((element) => element.type === "pcb_component" && element.source_component_id === source?.source_component_id)
    assert(component?.type === "pcb_component" && component.rotation === 90, `${name} rotation changed`)
    const expectedX = name === "J_CAM_LEFT" ? -11.43 : 11.43
    assert(Math.abs(component.center.x - expectedX) < 1e-6 && Math.abs(component.center.y - 3) < 1e-6, `${name} socket spacing changed`)
    return signals.map((signal, index) => {
      const label = `${name}:${signal}`
      const port = pcbPorts.find((port) => pcbLabels.get(port.pcb_port_id) === label)
      assert(port && Math.abs(port.x - expectedX) < 1e-6 && Math.abs(port.y - (3 - 8.89 + index * 2.54)) < 1e-6,
        `${label} does not match the manufacturer's signal position`)
      const hole = circuit.find((element) => element.type === "pcb_plated_hole" && element.pcb_port_id === port.pcb_port_id)
      assert(hole?.type === "pcb_plated_hole" && "hole_diameter" in hole && typeof hole.hole_diameter === "number" && Math.abs(hole.hole_diameter - 1) < 1e-6 && equalSet(hole.layers, ["top", "bottom"]), `${label} has incorrect socket hole geometry`)
      return { signal, x: port.x, y: port.y }
    })
  })
  return { passed: true, sourceEndpointCount: sourcePorts.length, schematicEndpointCount: schematicPorts.length, connectedEndpointCount: endpoints.length - expectedUnconnected.length,
    expectedUnconnectedEndpoints: expectedUnconnected, netCount: nets.length, pcbRouteCount: pcbTraces.length,
    viaCount: circuit.filter((element) => element.type === "pcb_via").length, nets, socketPositions }
}
