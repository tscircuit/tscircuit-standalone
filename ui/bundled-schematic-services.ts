import type { SchematicViewerServices } from "@tscircuit/schematic-viewer/source"
import { convertCircuitJsonToPcbSvg } from "circuit-to-svg"

/** Local alternatives for the viewer's request-producing services. */
export const bundledSchematicServices: SchematicViewerServices = {
  // Prices and live inventory are deliberately absent from the parts catalog.
  fetchJlcPartAvailability: async () => null,
  getFootprintPreviewUrl: (circuitJson, bounds) => {
    const svg = convertCircuitJsonToPcbSvg(circuitJson, {
      width: 320,
      height: 240,
      viewport: bounds,
      includeVersion: false,
    })
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  },
  loadStyleAnalyzer: () => import("@tscircuit/circuit-json-schematic-placement-analysis"),
}
