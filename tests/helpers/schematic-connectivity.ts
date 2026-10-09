import type { AnyCircuitElement } from "circuit-json"

type Point = { x: number; y: number }
const epsilon = 1e-6
const pointKey = ({ x, y }: Point) => `${x.toFixed(6)},${y.toFixed(6)}`

/** Check drawn wire continuity to a label, independently of source net membership. */
export function schematicPortReachesNetLabel(
  elements: AnyCircuitElement[],
  componentName: string,
  pinNumber: number,
  netName: string,
): boolean {
  const component = elements.find((e) => e.type === "source_component" && e.name === componentName)
  if (component?.type !== "source_component") return false
  const sourcePort = elements.find((e) => e.type === "source_port" && e.source_component_id === component.source_component_id && e.pin_number === pinNumber)
  if (sourcePort?.type !== "source_port") return false
  const port = elements.find((e) => e.type === "schematic_port" && e.source_port_id === sourcePort.source_port_id)
  const net = elements.find((e) => e.type === "source_net" && e.name === netName)
  if (port?.type !== "schematic_port" || net?.type !== "source_net") return false
  const traces = elements.filter((e) => e.type === "schematic_trace" && e.schematic_sheet_id === port.schematic_sheet_id && e.subcircuit_connectivity_map_key === net.subcircuit_connectivity_map_key)
  const labels = elements.filter((e) => e.type === "schematic_net_label" && e.source_net_id === net.source_net_id && e.schematic_sheet_id === port.schematic_sheet_id)
  const edges = traces.flatMap((trace) => trace.type === "schematic_trace" ? trace.edges : [])
  const anchors: Point[] = labels.flatMap((label) => label.type === "schematic_net_label" && label.anchor_position ? [label.anchor_position] : [])
  const points = new Map<string, Point>()
  for (const point of [port.center, ...anchors, ...edges.flatMap((edge) => [edge.from, edge.to])]) points.set(pointKey(point), point)
  const adjacency = new Map<string, Set<string>>()
  for (const edge of edges) {
    const dx = edge.to.x - edge.from.x
    const dy = edge.to.y - edge.from.y
    const lengthSquared = dx * dx + dy * dy
    if (lengthSquared <= epsilon * epsilon) continue
    const pointsOnEdge = [...points.values()].filter((point) => {
      const px = point.x - edge.from.x
      const py = point.y - edge.from.y
      const projection = px * dx + py * dy
      return Math.abs(px * dy - py * dx) <= epsilon && projection >= -epsilon && projection <= lengthSquared + epsilon
    }).sort((a, b) => Math.hypot(a.x - edge.from.x, a.y - edge.from.y) - Math.hypot(b.x - edge.from.x, b.y - edge.from.y))
    for (let index = 1; index < pointsOnEdge.length; index++) {
      const from = pointKey(pointsOnEdge[index - 1]!)
      const to = pointKey(pointsOnEdge[index]!)
      if (!adjacency.has(from)) adjacency.set(from, new Set())
      if (!adjacency.has(to)) adjacency.set(to, new Set())
      adjacency.get(from)!.add(to)
      adjacency.get(to)!.add(from)
    }
  }
  const reachable = new Set<string>()
  const pending = [pointKey(port.center)]
  while (pending.length) {
    const point = pending.pop()!
    if (reachable.has(point)) continue
    reachable.add(point)
    pending.push(...(adjacency.get(point) ?? []))
  }
  return anchors.some((anchor) => reachable.has(pointKey(anchor)))
}
