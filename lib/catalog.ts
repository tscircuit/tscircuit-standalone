import { fp } from "@tscircuit/footprinter"
import type { AnyCircuitElement } from "circuit-json"
import { bundledParts } from "./bundled-parts"
import type {
  BundledCatalog,
  BundledPart,
  PartProvenance,
  SupplierPartNumber,
} from "./catalog-types"

export type { BundledCatalog, BundledPart, PartProvenance, SupplierPartNumber }

export class BundledPartNotFoundError extends Error {
  readonly code = "BUNDLED_PART_NOT_FOUND"

  constructor(supplierPartNumber: string) {
    super(
      `Part ${supplierPartNumber} is not bundled in tscircuit standalone. No network lookup was attempted.`,
    )
    this.name = "BundledPartNotFoundError"
  }
}

export { parseBundledPart } from "./catalog-validation"
import { parseBundledPart, getPadPin } from "./catalog-validation"
import { normalizeChipName } from "./datasheet-catalog"

/** Sort and validate recipes deterministically without storing generated pads. */
export const createCatalog = (entries: readonly unknown[]): BundledCatalog => {
  const parts = entries
    .map(parseBundledPart)
    .sort(
      (left, right) =>
        left.manufacturerPartNumber.localeCompare(right.manufacturerPartNumber, "en") ||
        (left.supplierPartNumber ?? left.componentName).localeCompare(
          right.supplierPartNumber ?? right.componentName,
          "en",
        ),
    )
  const bySupplierPartNumber = new Map<SupplierPartNumber, BundledPart>()
  const byManufacturerPartNumber = new Map<string, BundledPart>()
  for (const part of parts) {
    if (part.supplierPartNumber) {
      if (bySupplierPartNumber.has(part.supplierPartNumber)) {
        throw new Error(
          `Invalid standalone catalog: duplicate supplier part ${part.supplierPartNumber}`,
        )
      }
      bySupplierPartNumber.set(part.supplierPartNumber, part)
    }
    const mpn = normalizeChipName(part.manufacturerPartNumber)
    // Supplier variants of the same manufacturer part may share an MPN.
    if (!byManufacturerPartNumber.has(mpn)) byManufacturerPartNumber.set(mpn, part)
  }
  return Object.freeze({
    parts: Object.freeze(parts),
    get: (partNumber: string) =>
      bySupplierPartNumber.get(partNumber.trim().toUpperCase() as SupplierPartNumber) ??
      byManufacturerPartNumber.get(normalizeChipName(partNumber)),
  })
}

export const bundledCatalog = createCatalog(bundledParts)

export const getBundledPart = (
  supplierPartNumber: string,
  catalog: BundledCatalog = bundledCatalog,
): BundledPart => {
  const part = catalog.get(supplierPartNumber)
  if (!part) throw new BundledPartNotFoundError(supplierPartNumber)
  return part
}

export const getBundledPartFileName = (part: BundledPart): string =>
  part.supplierPartNumber ?? part.componentName

/**
 * Generate footprint-local geometry in mm: +X right, +Y up, +Z above the PCB.
 * Coordinates are points before component placement/rotation; layer is top.
 */
export const getBundledFootprintCircuitJson = (
  part: BundledPart,
): AnyCircuitElement[] =>
  fp
    .string(part.footprint)
    .circuitJson()
    .map((element) => {
      if (element.type !== "pcb_smtpad" && element.type !== "pcb_plated_hole") {
        return element
      }
      const pin = getPadPin(element.port_hints, part.pinLabels)
      return {
        ...element,
        port_hints: [
          ...new Set([...(element.port_hints ?? []), pin, ...part.pinLabels[pin]!]),
        ],
      }
    })

export const generateBundledComponentTsx = (part: BundledPart): string => {
  const provenance = part.provenance
  const attribution =
    "kind" in provenance
      ? `// Datasheet API record: ${provenance.datasheetId}\n${provenance.datasheetUrls.map((url) => `// ${url}`).join("\n")}`
      : `// Adapted from ${provenance.repository} (MIT), Copyright (c) 2025 tscircuit.\n// https://github.com/${provenance.repository}/blob/${provenance.commit}/${provenance.path}`
  const attributes = part.pinAttributes
    ? `    pinAttributes={${JSON.stringify(part.pinAttributes, null, 2)}}\n`
    : ""
  const supplier = part.supplierPartNumber
    ? `    supplierPartNumbers={{ jlcpcb: [${JSON.stringify(part.supplierPartNumber)}] }}\n`
    : ""
  return `${attribution}\nimport type { ChipProps } from "@tscircuit/props"\n\nconst pinLabels = ${JSON.stringify(part.pinLabels, null, 2)} as const\n\nexport const ${part.componentName} = (props: ChipProps<typeof pinLabels>) => (\n  <chip\n    pinLabels={pinLabels}\n${attributes}${supplier}    manufacturerPartNumber={${JSON.stringify(part.manufacturerPartNumber)}}\n    footprint={${JSON.stringify(part.footprint)}}\n    {...props}\n  />\n)\n\nexport default ${part.componentName}\n`
}

export const serializeCatalog = (entries: readonly unknown[]): string =>
  `${JSON.stringify(createCatalog(entries).parts, null, 2)}\n`
