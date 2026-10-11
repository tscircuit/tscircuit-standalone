export type SupplierPartNumber = `C${number}`

import type { CommonComponentProps } from "@tscircuit/props"

export interface ImportedPartProvenance {
  repository: string
  commit: string
  path: string
  license: "MIT"
}

export interface DatasheetPartProvenance {
  kind: "datasheet-api"
  datasheetId: string
  datasheetUrls: readonly string[]
}

export type PartProvenance = ImportedPartProvenance | DatasheetPartProvenance

export type PinAttributes = NonNullable<CommonComponentProps["pinAttributes"]>

/** Only the compact footprint recipe and verified pin mapping are stored. */
export interface BundledPart {
  supplier?: "jlcpcb"
  supplierPartNumber?: SupplierPartNumber
  manufacturerPartNumber: string
  componentName: string
  footprint: string
  pinLabels: Readonly<Record<string, readonly string[]>>
  pinAttributes?: PinAttributes
  provenance: Readonly<PartProvenance>
}

export interface BundledCatalog {
  readonly parts: readonly BundledPart[]
  get(partNumber: string): BundledPart | undefined
}
