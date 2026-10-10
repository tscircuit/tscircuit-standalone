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

const normalizePinHint = (hint: string): string => (/^\d+$/.test(hint) ? `pin${hint}` : hint)

/** Parse only a local footprinter recipe, never a URL or library reference. */
const parseCompactFootprint = (footprint: string): AnyCircuitElement[] => {
  if (!/^[a-z][a-z0-9]*(?:_[a-zA-Z0-9.+(),-]+)*$/.test(footprint)) {
    return invalidCatalog("footprint must be a local footprinter string")
  }
  try {
    const circuitJson = fp.string(footprint).circuitJson()
    if (
      !circuitJson.some(
        (element) => element.type === "pcb_smtpad" || element.type === "pcb_plated_hole",
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
    "componentType",
    "connectorStandard",
    "frequency",
    "loadCapacitance",
    "pinVariant",
    "internallyConnectedPins",
    "provenance",
  ])
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      return invalidCatalog(`unsupported part field ${key}`)
    }
  }
  if (input.supplier !== "jlcpcb") {
    return invalidCatalog("only jlcpcb supplier entries are supported initially")
  }
  const supplierPartNumber = readString(input.supplierPartNumber, "supplierPartNumber")
  if (!/^C[1-9]\d*$/.test(supplierPartNumber)) {
    return invalidCatalog("supplierPartNumber must be a JLCPCB C-number")
  }
  const componentName = readString(input.componentName, "componentName")
  // This name becomes an exported TSX function. Do not permit source injection.
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(componentName)) {
    return invalidCatalog("componentName must be a PascalCase identifier")
  }
  const manufacturerPartNumber = readString(input.manufacturerPartNumber, "manufacturerPartNumber")
  const footprint = readString(input.footprint, "footprint")
  if (
    input.componentType !== undefined &&
    input.componentType !== "connector" &&
    input.componentType !== "crystal"
  ) {
    return invalidCatalog("componentType must be connector or crystal when specified")
  }
  if (
    input.connectorStandard !== undefined &&
    (input.componentType !== "connector" || input.connectorStandard !== "usb_c")
  ) {
    return invalidCatalog("connectorStandard must be usb_c on a connector")
  }
  if (input.componentType === "crystal") {
    if (
      typeof input.frequency !== "string" ||
      !/^\d+(?:\.\d+)?(?:Hz|kHz|MHz)$/.test(input.frequency) ||
      input.pinVariant !== "four_pin" ||
      typeof input.loadCapacitance !== "string" ||
      !/^\d+(?:\.\d+)?pF$/.test(input.loadCapacitance)
    ) {
      return invalidCatalog("crystal must have a frequency, loadCapacitance and four_pin variant")
    }
  } else if (
    input.frequency !== undefined ||
    input.pinVariant !== undefined ||
    input.loadCapacitance !== undefined
  ) {
    return invalidCatalog("frequency, loadCapacitance and pinVariant belong to a crystal")
  }
  const footprintCircuitJson = parseCompactFootprint(footprint)
  const inputPinLabels = asObject(input.pinLabels, "pinLabels")
  const pinLabels: Record<string, readonly string[]> = {}
  const pinNames = Object.keys(inputPinLabels).sort(
    (left, right) => Number(left.slice(3)) - Number(right.slice(3)),
  )
  if (pinNames.length === 0) return invalidCatalog("pinLabels must not be empty")
  for (const pinName of pinNames) {
    if (!/^pin[1-9]\d*$/.test(pinName)) {
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
      if (numericAlias && Number(numericAlias[1]) !== Number(pinName.slice(3))) {
        return invalidCatalog(`${pinName} cannot alias physical pin${Number(numericAlias[1])}`)
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
    const matchedPins = pinNames.filter((pinName) =>
      pad.port_hints?.some(
        (hint) => normalizePinHint(hint) === pinName || pinLabels[pinName]!.includes(hint),
      ),
    )
    if (matchedPins.length !== 1) {
      return invalidCatalog("each copper pad must map to exactly one labeled pin")
    }
    mappedPins.add(matchedPins[0]!)
  }
  if (mappedPins.size !== pinNames.length) {
    return invalidCatalog("every labeled pin must map to a generated copper pad")
  }
  let internallyConnectedPins: readonly (readonly string[])[] | undefined
  if (input.internallyConnectedPins !== undefined) {
    if (!Array.isArray(input.internallyConnectedPins)) {
      return invalidCatalog("internallyConnectedPins must be an array")
    }
    internallyConnectedPins = Object.freeze(
      input.internallyConnectedPins.map((group) => {
        if (
          !Array.isArray(group) ||
          group.length < 2 ||
          new Set(group).size !== group.length ||
          group.some((pin) => !pinNames.includes(pin))
        ) {
          return invalidCatalog(
            "internal connections must name at least two distinct mapped physical pins",
          )
        }
        return Object.freeze([...group] as string[])
      }),
    )
  }
  const inputProvenance = asObject(input.provenance, "provenance")
  let provenance: PartProvenance
  if (inputProvenance.kind === "manufacturer-facts") {
    const keys = new Set(["kind", "datasheetUrl", "referenceUrl"])
    if (Object.keys(inputProvenance).some((key) => !keys.has(key))) {
      return invalidCatalog("unsupported manufacturer provenance field")
    }
    const httpsUrl = (value: unknown, label: string): string => {
      const url = readString(value, label)
      if (/[\s\u0000-\u001f\u007f]/.test(url)) {
        return invalidCatalog(`${label} must not contain whitespace or control characters`)
      }
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
          return invalidCatalog(`${label} must be a public HTTPS reference`)
        }
      } catch {
        return invalidCatalog(`${label} must be a public HTTPS reference`)
      }
      return url
    }
    provenance = Object.freeze({
      kind: "manufacturer-facts",
      datasheetUrl: httpsUrl(inputProvenance.datasheetUrl, "datasheetUrl"),
      referenceUrl: httpsUrl(inputProvenance.referenceUrl, "referenceUrl"),
    })
  } else {
    const keys = new Set(["repository", "commit", "path", "license"])
    if (Object.keys(inputProvenance).some((key) => !keys.has(key))) {
      return invalidCatalog("unsupported imported provenance field")
    }
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
    supplier: "jlcpcb",
    supplierPartNumber: supplierPartNumber as SupplierPartNumber,
    manufacturerPartNumber,
    componentName,
    footprint,
    pinLabels: Object.freeze(pinLabels),
    ...(input.componentType
      ? { componentType: input.componentType as "connector" | "crystal" }
      : {}),
    ...(input.connectorStandard === "usb_c" ? { connectorStandard: "usb_c" } : {}),
    ...(input.componentType === "crystal"
      ? {
          frequency: input.frequency as string,
          loadCapacitance: input.loadCapacitance as string,
          pinVariant: "four_pin" as const,
        }
      : {}),
    ...(internallyConnectedPins ? { internallyConnectedPins } : {}),
    provenance,
  })
}

/** Sort and validate recipes deterministically without storing generated pads. */
export const createCatalog = (entries: readonly unknown[]): BundledCatalog => {
  const parts = entries
    .map(parseBundledPart)
    .sort((left, right) => left.supplierPartNumber.localeCompare(right.supplierPartNumber, "en"))
  const bySupplierPartNumber = new Map<SupplierPartNumber, BundledPart>()
  for (const part of parts) {
    if (bySupplierPartNumber.has(part.supplierPartNumber)) {
      return invalidCatalog(`duplicate supplier part ${part.supplierPartNumber}`)
    }
    bySupplierPartNumber.set(part.supplierPartNumber, part)
  }
  return Object.freeze({
    parts: Object.freeze(parts),
    get: (supplierPartNumber: string) =>
      bySupplierPartNumber.get(supplierPartNumber.trim().toUpperCase() as SupplierPartNumber),
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

/**
 * Generate footprint-local geometry in mm: +X right, +Y up, +Z above the PCB.
 * Coordinates are points before component placement/rotation; layer is top.
 */
export const getBundledFootprintCircuitJson = (part: BundledPart): AnyCircuitElement[] =>
  fp
    .string(part.footprint)
    .circuitJson()
    .map((element) => {
      if (element.type !== "pcb_smtpad" && element.type !== "pcb_plated_hole") {
        return element
      }
      const pinEntry = Object.entries(part.pinLabels).find(([pinName, labels]) =>
        element.port_hints?.some(
          (hint) => normalizePinHint(hint) === pinName || labels.includes(hint),
        ),
      )!
      return {
        ...element,
        port_hints: [...new Set([...(element.port_hints ?? []), pinEntry[0], ...pinEntry[1]])],
      }
    })

export const generateBundledComponentTsx = (part: BundledPart): string => {
  const attribution =
    "kind" in part.provenance
      ? `// Independently authored manufacturer pin/function and package facts.\n// ${part.provenance.datasheetUrl}\n// Supplier land-pattern reference: ${part.provenance.referenceUrl}\n// Reference: JLCEDA/EasyEDA Official Library; https://lceda.cn/ ; https://easyeda.com`
      : `// Adapted from ${part.provenance.repository} (MIT), Copyright (c) 2025 tscircuit.\n// https://github.com/${part.provenance.repository}/blob/${part.provenance.commit}/${part.provenance.path}`
  const element = part.componentType ?? "chip"
  const importedPropsType =
    element === "connector"
      ? "ConnectorProps"
      : element === "crystal"
        ? "CrystalProps"
        : "ChipProps"
  const propsType =
    element === "connector"
      ? "ConnectorProps"
      : element === "crystal"
        ? 'Omit<CrystalProps, "frequency" | "pinVariant" | "loadCapacitance"> & { loadCapacitance?: CrystalProps["loadCapacitance"] }'
        : "ChipProps<typeof pinLabels>"
  const standard = part.connectorStandard
    ? `    standard=${JSON.stringify(part.connectorStandard)}\n`
    : ""
  const crystalProps =
    element === "crystal"
      ? `    frequency=${JSON.stringify(part.frequency)}\n    loadCapacitance=${JSON.stringify(part.loadCapacitance)}\n    pinVariant="four_pin"\n`
      : ""
  const internalPins = part.internallyConnectedPins
    ? `    internallyConnectedPins={${JSON.stringify(part.internallyConnectedPins)}}\n`
    : ""
  return `${attribution}\n// Remote CAD models are omitted from this standalone component.\nimport type { ${importedPropsType} } from "@tscircuit/props"\n\nconst pinLabels = ${JSON.stringify(part.pinLabels, null, 2)} as const\n\nexport const ${part.componentName} = (props: ${propsType}) => (\n  <${element}\n${standard}${crystalProps}${internalPins}    pinLabels={pinLabels}\n    supplierPartNumbers={{ jlcpcb: [${JSON.stringify(part.supplierPartNumber)}] }}\n    manufacturerPartNumber={${JSON.stringify(part.manufacturerPartNumber)}}\n    footprint={${JSON.stringify(part.footprint)}}\n    {...props}\n  />\n)\n\nexport default ${part.componentName}\n`
}

export const serializeCatalog = (entries: readonly unknown[]): string =>
  `${JSON.stringify(createCatalog(entries).parts, null, 2)}\n`
