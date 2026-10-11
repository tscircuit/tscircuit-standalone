/** Facts read from the public datasheet API; generated source is omitted. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface DatasheetPinInformation {
  pin_number: string
  name: string[]
  description: string
  capabilities: string[]
}

export interface DatasheetSnapshotPart {
  datasheet_id: string
  chip_name: string
  datasheet_pdf_urls: string[]
  pin_information: DatasheetPinInformation[]
  ai_description: string
  pin_attributes: Record<string, Record<string, JsonValue>>
  footprinter_string: string
}
