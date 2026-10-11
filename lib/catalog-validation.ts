import { fp } from "@tscircuit/footprinter"
import { pinAttributeMap } from "@tscircuit/props"
import type { AnyCircuitElement } from "circuit-json"
import type {
  BundledPart,
  PartProvenance,
  PinAttributes,
  SupplierPartNumber,
} from "./catalog-types"

const invalidCatalog = (message: string): never => {
  throw new Error(`Invalid standalone catalog: ${message}`)
}

const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidCatalog(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

const readString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    return invalidCatalog(`${label} must be a non-empty trimmed string`)
  }
  return value
}

/** Physical terminal IDs take precedence over shared aliases such as GND. */
export const getPadPin = (
  hints: readonly string[] = [],
  pinLabels: BundledPart["pinLabels"],
): string => {
  const pins = Object.keys(pinLabels)
  const physical = pins.filter((pin) =>
    hints.some((hint) => hint === pin || `pin${hint}` === pin),
  )
  if (physical.length === 1) return physical[0]!
  if (physical.length > 1)
    return invalidCatalog("copper pad has conflicting physical pin IDs")
  const aliases = pins.filter((pin) =>
    hints.some((hint) => pinLabels[pin]!.includes(hint)),
  )
  if (aliases.length !== 1)
    return invalidCatalog("each copper pad must map to exactly one labeled pin")
  return aliases[0]!
}

const freezeCopy = <T>(value: T): T => {
  const copy = JSON.parse(JSON.stringify(value)) as T
  const freeze = (item: unknown) => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child)
      Object.freeze(item)
    }
  }
  freeze(copy)
  return copy
}

/** Parse only a local footprinter recipe, never a URL or library reference. */
const parseCompactFootprint = (footprint: string): AnyCircuitElement[] => {
  if (
    !/^[a-z][a-z0-9]*(?:_[a-zA-Z0-9.+(),-]+)*$/.test(footprint) ||
    /padlayout|profile\(/i.test(footprint)
  ) {
    return invalidCatalog("footprint must be a local footprinter string")
  }
  try {
    const circuitJson = fp.string(footprint).circuitJson()
    if (
      !circuitJson.some(
        (element) =>
          element.type === "pcb_smtpad" || element.type === "pcb_plated_hole",
      )
    ) {
      return invalidCatalog("footprint must generate copper pads")
    }
    return circuitJson
  } catch (error) {
    return invalidCatalog(
      `footprint cannot be generated: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Validate untrusted catalog input before it becomes an embedded part. */
export const parseBundledPart = (value: unknown): BundledPart => {
  const input = asObject(value, "part")
  const allowedKeys = new Set([
    "supplier",
    "supplierPartNumber",
    "manufacturerPartNumber",
    "componentName",
    "footprint",
    "pinLabels",
    "pinAttributes",
    "provenance",
  ])
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      return invalidCatalog(`unsupported part field ${key}`)
    }
  }
  let supplierPartNumber: SupplierPartNumber | undefined
  if (input.supplier !== undefined || input.supplierPartNumber !== undefined) {
    if (input.supplier !== "jlcpcb")
      return invalidCatalog("only jlcpcb supplier entries are supported initially")
    const number = readString(input.supplierPartNumber, "supplierPartNumber")
    if (!/^C[1-9]\d*$/.test(number))
      return invalidCatalog("supplierPartNumber must be a JLCPCB C-number")
    supplierPartNumber = number as SupplierPartNumber
  }
  const componentName = readString(input.componentName, "componentName")
  // This name becomes an exported TSX function. Do not permit source injection.
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(componentName)) {
    return invalidCatalog("componentName must be a PascalCase identifier")
  }
  const manufacturerPartNumber = readString(
    input.manufacturerPartNumber,
    "manufacturerPartNumber",
  )
  const footprint = readString(input.footprint, "footprint")
  const footprintCircuitJson = parseCompactFootprint(footprint)
  const inputPinLabels = asObject(input.pinLabels, "pinLabels")
  const pinLabels: Record<string, readonly string[]> = {}
  const pinNames = Object.keys(inputPinLabels).sort(
    (left, right) => Number(left.slice(3)) - Number(right.slice(3)),
  )
  if (pinNames.length === 0) return invalidCatalog("pinLabels must not be empty")
  for (const pinName of pinNames) {
    if (!/^pin(?:0|[1-9]\d*|[A-Za-z][A-Za-z0-9_]*)$/.test(pinName)) {
      return invalidCatalog(`invalid pin mapping ${pinName}`)
    }
    const labels = inputPinLabels[pinName]
    if (!Array.isArray(labels) || labels.length === 0) {
      return invalidCatalog(`labels for ${pinName} must not be empty`)
    }
    const parsedLabels = labels.map((label) => readString(label, pinName))
    if (new Set(parsedLabels).size !== parsedLabels.length) {
      return invalidCatalog(`duplicate labels for ${pinName}`)
    }
    for (const label of parsedLabels) {
      const numericAlias = label.match(/^(?:pin)?(\d+)$/i)
      if (
        numericAlias &&
        (!/^pin(?:0|[1-9]\d*)$/.test(pinName) ||
          Number(numericAlias[1]) !== Number(pinName.slice(3)))
      ) {
        return invalidCatalog(
          `${pinName} cannot alias physical pin${Number(numericAlias[1])}`,
        )
      }
    }
    pinLabels[pinName] = Object.freeze(parsedLabels)
  }
  const pads = footprintCircuitJson.filter(
    (element) => element.type === "pcb_smtpad" || element.type === "pcb_plated_hole",
  )
  const mappedPins = new Set<string>()
  for (const pad of pads) {
    if (pad.type !== "pcb_smtpad" && pad.type !== "pcb_plated_hole") continue
    mappedPins.add(getPadPin(pad.port_hints, pinLabels))
  }
  if (mappedPins.size !== pinNames.length) {
    return invalidCatalog("every labeled pin must map to a generated copper pad")
  }
  let pinAttributes: PinAttributes | undefined
  if (input.pinAttributes !== undefined) {
    const attributes = asObject(input.pinAttributes, "pinAttributes")
    for (const [pin, value] of Object.entries(attributes)) {
      if (!pinNames.includes(pin))
        return invalidCatalog(`pinAttributes refer to an unmapped pin ${pin}`)
      if (!pinAttributeMap.strict().safeParse(value).success)
        return invalidCatalog(`invalid pinAttributes for ${pin}`)
    }
    pinAttributes = freezeCopy(attributes) as PinAttributes
  }
  const inputProvenance = asObject(input.provenance, "provenance")
  let provenance: PartProvenance
  if (inputProvenance.kind === "datasheet-api") {
    if (
      Object.keys(inputProvenance).some(
        (key) => !["kind", "datasheetId", "datasheetUrls"].includes(key),
      )
    )
      return invalidCatalog("unsupported datasheet provenance field")
    const datasheetId = readString(inputProvenance.datasheetId, "datasheetId")
    if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(datasheetId))
      return invalidCatalog("datasheetId must be a UUID")
    if (!Array.isArray(inputProvenance.datasheetUrls))
      return invalidCatalog("datasheetUrls must be an array")
    const datasheetUrls = inputProvenance.datasheetUrls.map((value) => {
      const url = readString(value, "datasheetUrl")
      const parsed = new URL(url)
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        /[\s\u0000-\u001f\u007f]/.test(url)
      )
        return invalidCatalog("datasheetUrl must be a public HTTPS reference")
      return url
    })
    provenance = Object.freeze({
      kind: "datasheet-api",
      datasheetId,
      datasheetUrls: Object.freeze(datasheetUrls),
    })
  } else {
    const repository = readString(inputProvenance.repository, "source repository")
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      return invalidCatalog("source repository must be owner/repository")
    }
    const commit = readString(inputProvenance.commit, "source commit")
    if (!/^[a-f0-9]{40}$/.test(commit)) {
      return invalidCatalog("source commit must be an exact Git SHA")
    }
    const path = readString(inputProvenance.path, "source path")
    if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.split("/").includes("..")) {
      return invalidCatalog("source path must be a repository-relative file path")
    }
    if (inputProvenance.license !== "MIT") {
      return invalidCatalog("source license must be MIT for the initial catalog")
    }
    provenance = Object.freeze({ repository, commit, path, license: "MIT" })
  }
  return Object.freeze({
    ...(supplierPartNumber ? { supplier: "jlcpcb" as const, supplierPartNumber } : {}),
    manufacturerPartNumber,
    componentName,
    footprint,
    pinLabels: Object.freeze(pinLabels),
    ...(pinAttributes ? { pinAttributes } : {}),
    provenance,
  })
}
