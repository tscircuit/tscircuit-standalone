import type { CircuitJson } from "circuit-json"

export type WifiCameraNetlist = {
  nets: { name: string; pins: [string, string | number][] }[]
  importedParts: Record<string, string>
}

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Bare-chip camera connectivity: ${message}`)
}
const equalSet = (left: Iterable<string>, right: Iterable<string>) =>
  [...new Set(left)].sort().join("\n") === [...new Set(right)].sort().join("\n")
const physicalPin = (component: string, pin: string | number) =>
  `${component}:pin${String(pin).replace(/^pin/, "")}`

/** Compare authored nets with source, schematic, and actual routed PCB endpoints. */
export function checkDiscreteWifiCamera(circuit: CircuitJson, expected: WifiCameraNetlist) {
  const components = circuit.filter((element) => element.type === "source_component")
  const sourcePorts = circuit.filter((element) => element.type === "source_port")
  const pcbPorts = circuit.filter((element) => element.type === "pcb_port")
  const schematicPorts = circuit.filter((element) => element.type === "schematic_port")
  const sourceTraces = circuit.filter((element) => element.type === "source_trace")
  const pcbTraces = circuit.filter((element) => element.type === "pcb_trace")
  const componentNames = new Map(components.map((component) => [component.source_component_id, component.name]))
  const sourceLabels = new Map(sourcePorts.map((port) => [port.source_port_id,
    physicalPin(componentNames.get(port.source_component_id!)!, port.pin_number!)]))
  const pcbLabels = new Map(pcbPorts.map((port) => [port.pcb_port_id, sourceLabels.get(port.source_port_id!)]))
  const wantedNets = expected.nets.map(({ name, pins }) => ({ name, endpoints: pins.map(([component, pin]) => physicalPin(component, pin)) }))
  const connectedEndpoints = wantedNets.flatMap((net) => net.endpoints)
  assert(new Set(connectedEndpoints).size === connectedEndpoints.length, "an expected pin belongs to multiple nets")
  assert(sourcePorts.every((port) => port.pin_number && componentNames.has(port.source_component_id!)), "a port lost its physical pin number")
  assert(new Set(sourceLabels.values()).size === sourceLabels.size, "physical source pin numbers are duplicated")
  assert(equalSet(pcbPorts.map((port) => port.source_port_id!), sourcePorts.map((port) => port.source_port_id)), "PCB omitted a source pin")
  assert(equalSet(schematicPorts.map((port) => port.source_port_id), sourcePorts.map((port) => port.source_port_id)), "schematic omitted a source pin")
  assert(connectedEndpoints.every((label) => [...sourceLabels.values()].includes(label)), "an intended net endpoint is missing")
  assert(components.length >= 30, "the fixture lost its bare-chip support circuitry")
  assert(circuit.filter((element) => element.type === "pcb_smtpad").length >= 100, "the fixture has too few physical SMD pads")
  assert(Object.keys(expected.importedParts).length >= 7, "the fixture must exercise multiple catalog chips and connectors")
  for (const [name, partNumber] of Object.entries(expected.importedParts)) {
    const component = components.find((component) => component.name === name)
    assert(component, `${name} imported component is missing`)
    assert(component.supplier_part_numbers?.jlcpcb?.includes(partNumber), `${name} did not use catalog part ${partNumber}`)
    assert(component.manufacturer_part_number, `${name} lost its manufacturer identity`)
    assert(!/ESP32.*(?:WROOM|WROVER|CAM)|AI.?THINKER/i.test(component.manufacturer_part_number), `${name} is a module instead of a bare chip`)
    const cad = circuit.find((element) => element.type === "cad_component" && element.source_component_id === component.source_component_id)
    assert(cad?.type === "cad_component" && cad.footprinter_string && !cad.model_obj_url && !cad.model_glb_url && !cad.model_stl_url,
      `${name} must use a bundled procedural footprint/model`)
  }
  for (const name of ["U_MCU", "U_FLASH", "U_LDO", "U_USB_ESD", "J_USB_C", "J_CAMERA", "J_AUX_POWER", "J_DEBUG", "J_GPIO"]) {
    assert(components.some((component) => component.name === name), `${name} required chip/connector is missing`)
  }
  const groups = new Map<string, Set<string>>()
  for (const trace of sourceTraces) {
    assert(trace.subcircuit_connectivity_map_key, `${trace.source_trace_id} has no source net`)
    const group = groups.get(trace.subcircuit_connectivity_map_key) ?? new Set<string>()
    trace.connected_source_port_ids.forEach((id) => group.add(sourceLabels.get(id)!))
    groups.set(trace.subcircuit_connectivity_map_key, group)
  }
  assert(groups.size === wantedNets.length, "unexpected source net count")
  const expectedByEndpoint = new Map(wantedNets.flatMap((net) => net.endpoints.map((label) => [label, net] as const)))
  const edges = new Map<string, string[][]>()
  for (const trace of pcbTraces) {
    const refs = [...new Set(trace.route.flatMap((point) => point.route_type === "wire"
      ? [point.start_pcb_port_id, point.end_pcb_port_id].filter((id): id is string => !!id) : []))]
    assert(refs.length === 2, `${trace.pcb_trace_id} does not join exactly two physical ports`)
    const endpoints = refs.map((id) => pcbLabels.get(id)!)
    const net = expectedByEndpoint.get(endpoints[0]!)
    assert(net && endpoints.every((label) => expectedByEndpoint.get(label) === net), `${trace.pcb_trace_id} crosses intended nets`)
    for (const point of trace.route) {
      if (point.route_type !== "wire") continue
      for (const id of [point.start_pcb_port_id, point.end_pcb_port_id]) {
        if (!id) continue
        const port = pcbPorts.find((port) => port.pcb_port_id === id)
        assert(port && Math.abs(port.x - point.x) < 1e-6 && Math.abs(port.y - point.y) < 1e-6,
          `${trace.pcb_trace_id} ends away from its referenced pad`)
      }
    }
    edges.set(net.name, [...(edges.get(net.name) ?? []), endpoints])
  }
  const nets = wantedNets.map(({ name, endpoints }) => {
    assert(endpoints.length >= 2, `${name} has no connection to qualify`)
    assert([...groups.values()].some((group) => equalSet(group, endpoints)), `${name} source endpoints changed`)
    const routes = edges.get(name) ?? []
    const reached = new Set([endpoints[0]!])
    let previous = 0
    while (reached.size !== previous) {
      previous = reached.size
      for (const edge of routes) if (edge.some((label) => reached.has(label))) edge.forEach((label) => reached.add(label))
    }
    assert(equalSet(reached, endpoints), `${name} has unrouted physical endpoints: ${endpoints.filter((label) => !reached.has(label)).join(", ")}`)
    return { name, endpoints, pcbRouteCount: routes.length, connected: true }
  })
  return { passed: true, componentCount: components.length, importedParts: expected.importedParts,
    sourceEndpointCount: sourcePorts.length, schematicEndpointCount: schematicPorts.length,
    connectedEndpointCount: connectedEndpoints.length,
    unconnectedEndpoints: [...sourceLabels.values()].filter((label) => !expectedByEndpoint.has(label)),
    netCount: nets.length, pcbRouteCount: pcbTraces.length,
    viaCount: circuit.filter((element) => element.type === "pcb_via").length, nets }
}
