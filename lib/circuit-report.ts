import type { AnyCircuitElement } from "circuit-json"

export interface CircuitBuildReport {
  sourceFile: string
  elementCounts: Record<string, number>
  errors: { type: string; message: string }[]
  warnings: { type: string; message: string }[]
}

export function inspectCircuitJson(
  circuitJson: AnyCircuitElement[],
  sourceFile: string,
): CircuitBuildReport {
  const elementCounts: Record<string, number> = {}
  const errors: CircuitBuildReport["errors"] = []
  const warnings: CircuitBuildReport["warnings"] = []
  for (const element of circuitJson) {
    elementCounts[element.type] = (elementCounts[element.type] ?? 0) + 1
    if (element.type.endsWith("_error") || element.type.endsWith("_warning")) {
      const diagnostic = {
        type: element.type,
        message: "message" in element && typeof element.message === "string"
          ? element.message
              .replace(/<[a-z_]+#\d+\s+name="([^"]+)"\s*\/>/gi,
                (_, name: string) => name.replace(/^\./, ""))
              .replace(/<[a-z_]+#\d+\(([^)]*)\)\s*\/>/gi,
                (_, selector: string) => selector.split(">").at(-1)!.trim().replace(/^\./, ""))
          : element.type.replaceAll("_", " "),
      }
      if (element.type.endsWith("_error")) errors.push(diagnostic)
      else warnings.push(diagnostic)
    }
  }
  return { sourceFile, elementCounts, errors, warnings }
}

