export type SupplierPartNumber = `C${number}`

export interface PartProvenance {
  repository: string
  commit: string
  path: string
  license: "MIT"
}

/** Only the compact footprint recipe and verified pin mapping are stored. */
export interface BundledPart {
  supplier: "jlcpcb"
  supplierPartNumber: SupplierPartNumber
  manufacturerPartNumber: string
  componentName: string
  footprint: string
  pinLabels: Readonly<Record<string, readonly string[]>>
  provenance: Readonly<PartProvenance>
}

export interface BundledCatalog {
  readonly parts: readonly BundledPart[]
  get(supplierPartNumber: string): BundledPart | undefined
}
