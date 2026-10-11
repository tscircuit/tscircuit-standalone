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

/** Resolve declared internal copper aliases without accepting missing logical pins. */
export function checkDiscreteCameraPorts(circuit: CircuitJson) {
  const components = circuit.filter((element) => element.type === "source_component")
  const sourcePorts = circuit.filter((element) => element.type === "source_port")
  const pcbPorts = circuit.filter((element) => element.type === "pcb_port")
  const schematicPorts = circuit.filter((element) => element.type === "schematic_port")
  const componentsById = new Map(components.map((component) => [component.source_component_id, component]))
  const portsById = new Map(sourcePorts.map((port) => [port.source_port_id, port]))
  assert(portsById.size === sourcePorts.length, "source port IDs are duplicated")
  const roots = new Map(sourcePorts.map((port) => [port.source_port_id, port.source_port_id]))
  const root = (id: string): string => roots.get(id) === id ? id : root(roots.get(id)!)
  const declared = new Map<string, string[]>()
  for (const component of components) {
    for (const group of component.internally_connected_source_port_ids ?? []) declared.set([...group].sort().join("\n"), group)
  }
  for (const connection of circuit.filter((element) => element.type === "source_component_internal_connection")) {
    assert(connection.source_port_ids.every((id) => portsById.get(id)?.source_component_id === connection.source_component_id), "an intrinsic connection has incorrect component ownership")
    declared.set([...connection.source_port_ids].sort().join("\n"), connection.source_port_ids)
  }
  const intrinsicGroups = [...declared.values()]
  for (const group of intrinsicGroups) {
    assert(group.length >= 2 && group.every((id) => portsById.has(id)), "an intrinsic connection references a missing source port")
    assert(new Set(group.map((id) => portsById.get(id)?.source_component_id)).size === 1, "an intrinsic connection crosses components")
    group.slice(1).forEach((id) => roots.set(root(id), root(group[0]!)))
  }
  const labels = new Map<string, string>()
  const numberedLabels = new Map<string, string>()
  const keysByRoot = new Map<string, Set<string>>()
  for (const port of sourcePorts) {
    const component = componentsById.get(port.source_component_id!)
    assert(component, `${port.source_port_id} has no component owner`)
    if (port.pin_number !== undefined) {
      assert(Number.isInteger(port.pin_number) && port.pin_number > 0, `${component.name}:${port.name} has an invalid physical pin number`)
      const label = physicalPin(component.name, port.pin_number)
      assert(!numberedLabels.has(label), `physical source pin ${label} is duplicated`)
      numberedLabels.set(label, port.source_port_id)
      labels.set(port.source_port_id, label)
    } else {
      const match = port.name.match(/^pin(\d+)_internal_\d+$/)
      // A connector's common metal shell can link several logical ground pins.
      // The duplicate copper still needs its own uniquely numbered anchor.
      const numberedAnchors = match ? sourcePorts.filter((candidate) => root(candidate.source_port_id) === root(port.source_port_id) && candidate.pin_number === Number(match[1])) : []
      assert(match && numberedAnchors.length === 1, `${component.name}:${port.name} lost its physical pin number or declared internal owner`)
      labels.set(port.source_port_id, `${component.name}:${port.name}`)
    }
    if (port.subcircuit_connectivity_map_key) {
      const keys = keysByRoot.get(root(port.source_port_id)) ?? new Set<string>()
      keys.add(port.subcircuit_connectivity_map_key)
      keysByRoot.set(root(port.source_port_id), keys)
    }
  }
  assert([...keysByRoot.values()].every((keys) => keys.size <= 1), "a declared intrinsic connection crosses source nets")
  const effectiveKeys = new Map(sourcePorts.map((port) => [port.source_port_id, [...(keysByRoot.get(root(port.source_port_id)) ?? [])][0]]))
  assert(equalSet(pcbPorts.map((port) => port.source_port_id!), portsById.keys()), "PCB omitted a source terminal")
  const visible = new Set(schematicPorts.map((port) => port.source_port_id))
  assert([...visible].every((id) => portsById.get(id)?.pin_number !== undefined), "schematic references an unknown logical pin")
  const schematicAliases: { physical: string; representedBy: string }[] = []
  for (const port of sourcePorts) {
    if (visible.has(port.source_port_id)) continue
    const component = componentsById.get(port.source_component_id!)!
    let owner = sourcePorts.find((candidate) => visible.has(candidate.source_port_id) && root(candidate.source_port_id) === root(port.source_port_id))
    // The ordinary four-pad button symbol represents contacts 3/4 by 1/2.
    // This exception only concerns the schematic; PCB reachability below
    // still requires routed copper or an explicit intrinsic connection.
    if (!owner && component.ftype === "simple_push_button" && [3, 4].includes(port.pin_number!)) {
      owner = sourcePorts.find((candidate) => candidate.source_component_id === port.source_component_id && candidate.pin_number === port.pin_number! - 2 && visible.has(candidate.source_port_id))
      assert(owner && effectiveKeys.get(port.source_port_id) && effectiveKeys.get(owner.source_port_id) === effectiveKeys.get(port.source_port_id), `${labels.get(port.source_port_id)} button contact differs from its schematic terminal`)
    }
    assert(owner && (port.pin_number === undefined || component.ftype === "simple_push_button"), `${labels.get(port.source_port_id)} is missing from the schematic`)
    schematicAliases.push({ physical: labels.get(port.source_port_id)!, representedBy: labels.get(owner.source_port_id)! })
  }
  const pcbById = new Map(pcbPorts.map((port) => [port.pcb_port_id, port]))
  const copper = circuit.filter((element) => element.type === "pcb_smtpad" || element.type === "pcb_plated_hole")
  assert(copper.every((element) => element.pcb_port_id && pcbById.has(element.pcb_port_id)), "copper pad/hole has no PCB terminal owner")
  for (const element of copper) {
    const port = pcbById.get(element.pcb_port_id!)!
    assert(element.pcb_component_id === port.pcb_component_id, "copper pad/hole and terminal disagree on component ownership")
    if ("x" in element && "y" in element) assert(Math.abs(element.x - port.x) < 1e-6 && Math.abs(element.y - port.y) < 1e-6, "copper pad/hole is displaced from its terminal")
  }
  assert(pcbPorts.every((port) => copper.some((element) => element.pcb_port_id === port.pcb_port_id) || circuit.some((element) => element.type === "pcb_via" && element.pcb_port_ids?.includes(port.pcb_port_id))), "PCB terminal has no copper pad, hole, or via")
  return { components, sourcePorts, pcbPorts, schematicPorts, labels, numberedLabels, effectiveKeys, intrinsicGroups, schematicAliases,
    sourceEndpointCount: sourcePorts.length, physicalPinCount: numberedLabels.size, copperTerminalCount: pcbPorts.length,
    schematicEndpointCount: schematicPorts.length, declaredIntrinsicConnectionCount: intrinsicGroups.length }
}

/** Compare authored nets with source, schematic, and actual routed PCB endpoints. */
export function checkDiscreteCameraNets(circuit: CircuitJson, expected: WifiCameraNetlist) {
  const topology = checkDiscreteCameraPorts(circuit)
  const { components, sourcePorts, pcbPorts, schematicPorts, labels: sourceLabels, numberedLabels, effectiveKeys, intrinsicGroups } = topology
  const sourceTraces = circuit.filter((element) => element.type === "source_trace")
  const pcbTraces = circuit.filter((element) => element.type === "pcb_trace")
  const pcbLabels = new Map(pcbPorts.map((port) => [port.pcb_port_id, sourceLabels.get(port.source_port_id!)]))
  const wantedNets = expected.nets.map(({ name, pins }) => ({ name, endpoints: pins.map(([component, pin]) => physicalPin(component, pin)) }))
  const connectedEndpoints = wantedNets.flatMap((net) => net.endpoints)
  assert(new Set(connectedEndpoints).size === connectedEndpoints.length, "an expected pin belongs to multiple nets")
  assert(connectedEndpoints.every((label) => numberedLabels.has(label)), "an intended net endpoint is missing")
  const groups = new Map<string, Set<string>>()
  for (const trace of sourceTraces) {
    assert(trace.subcircuit_connectivity_map_key, `${trace.source_trace_id} has no source net`)
    const group = groups.get(trace.subcircuit_connectivity_map_key) ?? new Set<string>()
    trace.connected_source_port_ids.forEach((id) => group.add(sourceLabels.get(id)!))
    groups.set(trace.subcircuit_connectivity_map_key, group)
  }
  for (const port of sourcePorts) {
    const key = effectiveKeys.get(port.source_port_id)
    if (!key || port.pin_number === undefined) continue
    assert(groups.get(key)?.has(sourceLabels.get(port.source_port_id)!), `${sourceLabels.get(port.source_port_id)} source port disagrees with its traces`)
  }
  assert(groups.size === wantedNets.length, "unexpected source net count")
  const netByKey = new Map<string, typeof wantedNets[number]>()
  for (const net of wantedNets) {
    assert([...groups.values()].some((group) => equalSet(group, net.endpoints)), `${net.name} source endpoints changed`)
    const keys = new Set(net.endpoints.map((label) => effectiveKeys.get(numberedLabels.get(label)!)))
    assert(keys.size === 1 && !keys.has(undefined), `${net.name} physical pins disagree with source connectivity`)
    netByKey.set([...keys][0]!, net)
  }
  const expectedByPcb = new Map(pcbPorts.map((port) => [port.pcb_port_id, netByKey.get(effectiveKeys.get(port.source_port_id!)!)]))
  const edges = new Map<string, string[][]>()
  for (const trace of pcbTraces) {
    const refs = [...new Set(trace.route.flatMap((point) => point.route_type === "wire"
      ? [point.start_pcb_port_id, point.end_pcb_port_id].filter((id): id is string => !!id) : []))]
    assert(refs.length === 2, `${trace.pcb_trace_id} does not join exactly two physical ports`)
    const net = expectedByPcb.get(refs[0]!)
    assert(net && refs.every((id) => expectedByPcb.get(id) === net), `${trace.pcb_trace_id} crosses intended nets`)
    for (const point of trace.route) {
      if (point.route_type !== "wire") continue
      for (const id of [point.start_pcb_port_id, point.end_pcb_port_id]) {
        if (!id) continue
        const port = pcbPorts.find((port) => port.pcb_port_id === id)
        assert(port && Math.abs(port.x - point.x) < 1e-6 && Math.abs(port.y - point.y) < 1e-6,
          `${trace.pcb_trace_id} ends away from its referenced pad`)
      }
    }
    edges.set(net.name, [...(edges.get(net.name) ?? []), refs])
  }
  for (const group of intrinsicGroups) {
    const terminals = pcbPorts.filter((port) => group.includes(port.source_port_id!))
    const net = expectedByPcb.get(terminals[0]?.pcb_port_id ?? "")
    if (!net) continue
    assert(terminals.every((port) => expectedByPcb.get(port.pcb_port_id) === net), "an intrinsic PCB connection crosses intended nets")
    const intrinsicEdges = terminals.slice(1).map((port) => [terminals[0]!.pcb_port_id, port.pcb_port_id])
    edges.set(net.name, [...(edges.get(net.name) ?? []), ...intrinsicEdges])
  }
  const nets = wantedNets.map(({ name, endpoints }) => {
    assert(endpoints.length >= 2, `${name} has no connection to qualify`)
    assert([...groups.values()].some((group) => equalSet(group, endpoints)), `${name} source endpoints changed`)
    const routes = edges.get(name) ?? []
    const terminals = pcbPorts.filter((port) => expectedByPcb.get(port.pcb_port_id)?.name === name)
    const reached = new Set([terminals[0]!.pcb_port_id])
    let previous = 0
    while (reached.size !== previous) {
      previous = reached.size
      for (const edge of routes) if (edge.some((label) => reached.has(label))) edge.forEach((label) => reached.add(label))
    }
    assert(equalSet(reached, terminals.map((port) => port.pcb_port_id)), `${name} has unrouted physical endpoints: ${terminals.filter((port) => !reached.has(port.pcb_port_id)).map((port) => pcbLabels.get(port.pcb_port_id)).join(", ")}`)
    return { name, endpoints, copperTerminalCount: terminals.length, pcbRouteCount: pcbTraces.filter((trace) => trace.route.some((point) => point.route_type === "wire" && expectedByPcb.get(point.start_pcb_port_id ?? "")?.name === name)).length, connected: true }
  })
  return { passed: true, componentCount: components.length,
    sourceEndpointCount: sourcePorts.length, schematicEndpointCount: schematicPorts.length,
    physicalPinCount: topology.physicalPinCount, copperTerminalCount: topology.copperTerminalCount,
    declaredIntrinsicConnectionCount: intrinsicGroups.length, schematicAliases: topology.schematicAliases,
    connectedEndpointCount: connectedEndpoints.length,
    unconnectedEndpoints: sourcePorts.filter((port) => !effectiveKeys.get(port.source_port_id)).map((port) => sourceLabels.get(port.source_port_id)),
    netCount: nets.length, pcbRouteCount: pcbTraces.length,
    viaCount: circuit.filter((element) => element.type === "pcb_via").length, nets }
}

/** Require real catalog identities in addition to a complete electrical graph. */
export function checkDiscreteWifiCamera(circuit: CircuitJson, expected: WifiCameraNetlist) {
  const connectivity = checkDiscreteCameraNets(circuit, expected)
  const components = circuit.filter((element) => element.type === "source_component")
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
  for (const name of ["U_MCU", "U_FLASH", "U_LDO", "U_USB_ESD", "J_USB_C", "J_CAMERA", "J_AUX_3V3", "J_DEBUG", "J_GPIO"]) {
    assert(components.some((component) => component.name === name), `${name} required chip/connector is missing`)
  }
  return { ...connectivity, importedParts: expected.importedParts }
}
