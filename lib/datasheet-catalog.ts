import { fp } from "@tscircuit/footprinter"
import { parseBundledPart } from "./catalog-validation"
import type { BundledPart, SupplierPartNumber } from "./catalog-types"
import type { DatasheetSnapshotPart } from "./datasheet-snapshot-types"

/** The same normalization used by the datasheet API and ordinary CLI. */
export const normalizeChipName = (name: string): string =>
  name.replace(/[^0-9a-zA-Z_-]/g, "").toLowerCase()

/** Names can contain punctuation; generated exports and filenames cannot. */
const componentNameFor = (name: string): string => {
  const identifier = name.replace(
    /[^A-Za-z0-9]/g,
    (character) => `_u${character.codePointAt(0)!.toString(16)}_`,
  )
  return /^[A-Z]/.test(identifier) ? identifier : `Part_${identifier}`
}

/** Produce usable selectors without merging different datasheet signal names. */
const selectorNamesFor = (names: readonly string[]): Map<string, string> => {
  const selectors = new Map<string, string>()
  const owners = new Map<string, string>()
  const valid = /^[A-Za-z0-9_]+$/
  const uniqueNames = [...new Set(names)].sort()
  // Existing selector spellings take precedence over normalized punctuation.
  for (const name of uniqueNames.filter((name) => valid.test(name))) {
    selectors.set(name, name)
    owners.set(name, name)
  }
  for (const name of uniqueNames.filter((name) => !valid.test(name))) {
    let selector = name
      .replace(/\+/g, "_POS")
      .replace(/-$/, "_NEG")
      .replace(/#/g, "_N")
      .replace(/^~/, "NOT_")
      .replace(/[^A-Za-z0-9_]/g, "_")
    if (!selector) selector = "SIGNAL"
    if (owners.has(selector) && owners.get(selector) !== name) {
      selector = name.replace(
        /[^A-Za-z0-9]/g,
        (character) => `_u${character.codePointAt(0)!.toString(16)}_`,
      )
    }
    while (owners.has(selector) && owners.get(selector) !== name) {
      selector += "_"
    }
    selectors.set(name, selector)
    owners.set(selector, name)
  }
  return selectors
}

const comparePhysicalPins = (left: string, right: string): number => {
  const leftCoordinate = left.match(/^([A-Z]+)([1-9]\d*)$/i)
  const rightCoordinate = right.match(/^([A-Z]+)([1-9]\d*)$/i)
  if (leftCoordinate && rightCoordinate) {
    const rowNumber = (letters: string) =>
      [...letters.toUpperCase()].reduce(
        (row, letter) => row * 26 + letter.charCodeAt(0) - 64,
        0,
      )
    return (
      rowNumber(leftCoordinate[1]!) - rowNumber(rightCoordinate[1]!) ||
      Number(leftCoordinate[2]) - Number(rightCoordinate[2])
    )
  }
  return left.localeCompare(right, "en", { numeric: true })
}

/** Adapt API facts without executing generated_tsx or storing expanded pads. */
export const adaptDatasheetPart = (
  datasheet: DatasheetSnapshotPart,
  supplierPartNumber?: SupplierPartNumber,
): BundledPart => {
  const pinLabels: Record<string, readonly string[]> = {}
  const physicalPins = new Map<string, string>()
  const pins = [...datasheet.pin_information].sort((left, right) =>
    comparePhysicalPins(left.pin_number, right.pin_number),
  )
  const selectors = selectorNamesFor(
    pins.flatMap((pin) => [pin.pin_number, ...pin.name]),
  )
  const originalAliases = new Map<string, string[]>()
  const numericOwners = new Map(
    pins
      .filter((pin) => /^\d+$/.test(pin.pin_number))
      .map((pin) => [Number(pin.pin_number), pin.pin_number]),
  )
  const namedOrdinals = new Map<string, number>()
  if (pins.some((pin) => !/^\d+$/.test(pin.pin_number))) {
    const copper = fp
      .string(datasheet.footprinter_string)
      .circuitJson()
      .filter(
        (element) =>
          element.type === "pcb_smtpad" || element.type === "pcb_plated_hole",
      )
    for (const pin of pins.filter((pin) => !/^\d+$/.test(pin.pin_number))) {
      const hints = copper
        .filter((pad) =>
          pad.port_hints?.some(
            (hint) => hint === pin.pin_number || hint === `pin${pin.pin_number}`,
          ),
        )
        .flatMap((pad) => pad.port_hints ?? [])
      const ordinals = new Set(
        hints
          .filter((hint) => /^(?:pin)?\d+$/.test(hint))
          .map((hint) => Number(hint.replace(/^pin/, ""))),
      )
      if (ordinals.size !== 1) continue
      const ordinal = [...ordinals][0]!
      if (numericOwners.has(ordinal)) {
        throw new Error(
          `Footprint ordinal ${ordinal} conflicts between physical terminals ${numericOwners.get(ordinal)} and ${pin.pin_number}`,
        )
      }
      numericOwners.set(ordinal, pin.pin_number)
      namedOrdinals.set(pin.pin_number, ordinal)
    }
  }
  let nextNumber = Math.max(0, ...numericOwners.keys()) + 1
  for (const pin of pins) {
    if (physicalPins.has(pin.pin_number))
      throw new Error(`Duplicate physical terminal ${pin.pin_number}`)
    // Core uses numeric source-port keys. Package coordinates remain aliases
    // so Footprinter copper and authored selectors retain their physical IDs.
    const number = /^\d+$/.test(pin.pin_number)
      ? pin.pin_number
      : String(namedOrdinals.get(pin.pin_number) ?? nextNumber++)
    const key = `pin${number}`
    physicalPins.set(pin.pin_number, key)
    const aliases = [
      ...(/^\d+$/.test(pin.pin_number) ? [] : [pin.pin_number]),
      ...pin.name,
    ]
    pinLabels[key] = [...new Set(aliases.map((alias) => selectors.get(alias)!))]
    for (const alias of pin.name) {
      originalAliases.set(alias, [...(originalAliases.get(alias) ?? []), key])
    }
  }
  const pinAttributes: Record<string, unknown> = {}
  for (const [key, attributes] of Object.entries(datasheet.pin_attributes)) {
    const physical = physicalPins.get(key.replace(/^pin/, ""))
    const pins = physical
      ? [physical]
      : key in pinLabels
        ? [key]
        : `pin${key}` in pinLabels
          ? [`pin${key}`]
          : (originalAliases.get(key) ?? [])
    if (!pins.length) throw new Error(`pinAttributes refer to an unmapped pin ${key}`)
    for (const pin of pins) {
      if (
        pin in pinAttributes &&
        JSON.stringify(pinAttributes[pin]) !== JSON.stringify(attributes)
      ) {
        throw new Error(`Conflicting pinAttributes for ${pin}`)
      }
      pinAttributes[pin] = attributes
    }
  }
  return parseBundledPart({
    ...(supplierPartNumber ? { supplier: "jlcpcb", supplierPartNumber } : {}),
    manufacturerPartNumber: datasheet.chip_name,
    componentName: componentNameFor(datasheet.chip_name),
    footprint: datasheet.footprinter_string,
    pinLabels,
    pinAttributes,
    provenance: {
      kind: "datasheet-api",
      datasheetId: datasheet.datasheet_id,
      datasheetUrls: datasheet.datasheet_pdf_urls,
    },
  })
}
