export type SupplierPartNumber = `C${number}`

export interface ImportedPartProvenance {
  repository: string
  commit: string
  path: string
  license: "MIT"
}

/** Independently authored pin/function facts; no upstream source code is copied. */
export interface ManufacturerPartProvenance {
  kind: "manufacturer-facts"
  datasheetUrl: string
  referenceUrl: string
}

export type PartProvenance = ImportedPartProvenance | ManufacturerPartProvenance

/** Only the compact footprint recipe and verified pin mapping are stored. */
export interface BundledPart {
  supplier: "jlcpcb"
  supplierPartNumber: SupplierPartNumber
  manufacturerPartNumber: string
  componentName: string
  footprint: string
  pinLabels: Readonly<Record<string, readonly string[]>>
  componentType?: "connector" | "crystal"
  connectorStandard?: "usb_c"
  frequency?: string
  loadCapacitance?: string
  pinVariant?: "four_pin"
  internallyConnectedPins?: readonly (readonly string[])[]
  provenance: Readonly<PartProvenance>
}

export interface BundledCatalog {
  readonly parts: readonly BundledPart[]
  get(supplierPartNumber: string): BundledPart | undefined
}
