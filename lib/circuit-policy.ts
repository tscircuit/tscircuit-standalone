import type { RootCircuit } from "@tscircuit/core"
import type { AnyCircuitElement } from "circuit-json"
import { bundledCatalog, getBundledPart } from "./catalog"

/** Inspect authored providers before core starts any render effects. */
export const validateAuthoredCircuit = (circuit: RootCircuit) => {
  const components = [...circuit.children]
  while (components.length > 0) {
    const component = components.pop()!
    components.push(...component.children)
    const { partsEngine, autorouter } = component.props
    if (partsEngine !== undefined) {
      throw new Error(
        `Custom parts engines on ${component.getDisplayName()} are unsupported in standalone builds. The bundled parts engine is required.`,
      )
    }
    const preset =
      typeof autorouter === "string" ? autorouter : autorouter?.preset
    if (
      preset?.replace(/-/g, "_") === "auto_cloud" ||
      (typeof autorouter === "object" &&
        autorouter &&
        (autorouter.local === false ||
          autorouter.serverUrl ||
          autorouter.serverMode ||
          autorouter.serverCacheEnabled === true))
    ) {
      throw new Error(
        `Remote autorouting on ${component.getDisplayName()} is unavailable in standalone builds. Use the default local autorouter.`,
      )
    }
  }
}

const normalizeMpn = (manufacturerPartNumber: string) =>
  manufacturerPartNumber.trim().toUpperCase()

export const validateSourceParts = (circuitJson: AnyCircuitElement[]) => {
  for (const sourceComponent of circuitJson) {
    if (sourceComponent.type !== "source_component") continue
    const name = sourceComponent.name || "unnamed component"
    const manufacturerPartNumber = sourceComponent.manufacturer_part_number
    const supplierParts = Object.entries(
      sourceComponent.supplier_part_numbers ?? {},
    )
    for (const [supplier, supplierPartNumbers] of supplierParts) {
      if (!supplierPartNumbers?.length) continue
      if (supplier !== "jlcpcb") {
        throw new Error(
          `Supplier ${supplier} on ${name} is not supported by the bundled catalog.`,
        )
      }
      for (const supplierPartNumber of supplierPartNumbers) {
        const part = getBundledPart(supplierPartNumber)
        if (
          manufacturerPartNumber &&
          normalizeMpn(part.manufacturerPartNumber) !==
            normalizeMpn(manufacturerPartNumber)
        ) {
          throw new Error(
            `Part ${supplierPartNumber} on ${name} is ${part.manufacturerPartNumber}, which does not match declared manufacturer part ${manufacturerPartNumber}.`,
          )
        }
      }
    }
    if (
      manufacturerPartNumber &&
      !bundledCatalog.parts.some(
        (part) =>
          normalizeMpn(part.manufacturerPartNumber) ===
          normalizeMpn(manufacturerPartNumber),
      )
    ) {
      throw new Error(
        `Manufacturer part ${manufacturerPartNumber} on ${name} is not bundled in tscircuit standalone. No network lookup was attempted.`,
      )
    }
  }
}

const requireEmbeddedAsset = (url: string | undefined, label: string) => {
  if (!url) return
  // This build does not package filesystem, blob, or remote viewer assets.
  if (!url.startsWith("data:")) {
    throw new Error(
      `${label} ${url} is not embedded in this standalone build. Use a procedural footprinter model or inline asset.`,
    )
  }
}

const MAX_INLINE_ASSET_BYTES = 8 * 1024 * 1024
const MAX_ASSET_DEPTH = 8
const UNSUPPORTED_GLTF_DECODERS = new Set([
  "KHR_draco_mesh_compression",
  "KHR_texture_basisu",
  "EXT_meshopt_compression",
])

const assetError = (label: string, reason: string): never => {
  throw new Error(`${label} ${reason} in tscircuit standalone.`)
}

/** Decode inline compound assets without Node APIs, for both worker runtimes. */
const decodeDataAsset = (url: string, label: string) => {
  requireEmbeddedAsset(url, label)
  const separator = url.indexOf(",")
  if (separator < 0) return assetError(label, "has an invalid data URI")
  const header = url.slice(5, separator).split(";")
  const mimetype = header[0].toLowerCase()
  const encoded = url.slice(separator + 1)
  const base64 = header.some((part) => part.toLowerCase() === "base64")
  // Bound the input before allocating its decoded representation.
  if (encoded.length > MAX_INLINE_ASSET_BYTES * (base64 ? 4 : 3) + 4) {
    return assetError(label, "exceeds the 8 MiB inline asset limit")
  }
  try {
    if (base64) {
      const binary = atob(decodeURIComponent(encoded))
      if (binary.length > MAX_INLINE_ASSET_BYTES) {
        return assetError(label, "exceeds the 8 MiB inline asset limit")
      }
      return {
        mimetype,
        bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      }
    }
    // Percent escapes are bytes, including UTF-8 sequences and binary GLBs.
    const bytes: number[] = []
    for (let index = 0; index < encoded.length; index++) {
      if (encoded[index] === "%") {
        const pair = encoded.slice(index + 1, index + 3)
        if (!/^[\da-f]{2}$/i.test(pair))
          throw new Error("Invalid percent escape")
        bytes.push(Number.parseInt(pair, 16))
        index += 2
      } else {
        const codePoint = encoded.codePointAt(index)!
        const character = String.fromCodePoint(codePoint)
        if (codePoint < 0x80) bytes.push(codePoint)
        else bytes.push(...new TextEncoder().encode(character))
        if (codePoint > 0xffff) index++
      }
      if (bytes.length > MAX_INLINE_ASSET_BYTES) {
        return assetError(label, "exceeds the 8 MiB inline asset limit")
      }
    }
    return { mimetype, bytes: Uint8Array.from(bytes) }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.endsWith("in tscircuit standalone.")
    )
      throw error
    return assetError(label, "has an invalid data URI")
  }
}

const decodeAssetText = (bytes: Uint8Array, label: string) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return assetError(label, "contains invalid UTF-8 text")
  }
}

const decodeXmlReferences = (text: string, label: string) =>
  text.replace(/&(#x[\da-f]+|#\d+|[\w]+);/gi, (_match, entity: string) => {
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    }
    if (named[entity]) return named[entity]
    if (entity.startsWith("#")) {
      const code =
        entity[1].toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
      if (code > 0 && code <= 0x10ffff) return String.fromCodePoint(code)
    }
    return assetError(label, "contains an unsupported XML entity")
  })

const validateSvgText = (text: string, label: string, depth: number) => {
  if (depth > MAX_ASSET_DEPTH)
    return assetError(label, "exceeds the inline reference depth limit")
  if (text.length > MAX_INLINE_ASSET_BYTES)
    return assetError(label, "exceeds the 8 MiB inline asset limit")
  if (
    /<!\s*(?:DOCTYPE|ENTITY)\b|<\?\s*xml-stylesheet\b|<\s*(?:[\w.-]+:)?(?:script|foreignObject|animate|animateMotion|animateTransform|set|object|embed|iframe|link|img|audio|video|source|track|base|form|input)\b|\bon[\w]+\s*=/i.test(
      text,
    )
  ) {
    return assetError(label, "contains unsupported active SVG content")
  }
  const reference = (value: string) => {
    value = decodeXmlReferences(value, label).trim()
    if (value.startsWith("#")) return
    requireEmbeddedAsset(value, `${label} reference`)
    if (!value) return assetError(label, "contains an empty resource reference")
    validateInlineImage(value, `${label} reference`, depth + 1)
  }
  for (const match of text.matchAll(
    /\b(?:[\w.-]+:)?(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
  )) {
    reference(match[1] ?? match[2] ?? match[3])
  }
  // CSS escapes can conceal both a URL scheme and the url()/@import token.
  const css = decodeXmlReferences(text, label)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\(?:\r\n|[\r\n\f])/g, "")
    .replace(
      /\\([\da-f]{1,6})(?:[ \t\r\n\f])?|\\([^\r\n\f])/gi,
      (_match, hex: string | undefined, character: string | undefined) => {
        const code = hex ? Number.parseInt(hex, 16) : 0
        return hex
          ? String.fromCodePoint(code > 0 && code <= 0x10ffff ? code : 0xfffd)
          : character!
      },
    )
  if (/@\s*import\b/i.test(css))
    return assetError(label, "contains an unsupported CSS import")
  if (/\b(?:image|(?:-webkit-)?image-set|cross-fade)\s*\(/i.test(css))
    return assetError(label, "contains an unsupported CSS image function")
  const tokens = [...css.matchAll(/\burl\s*\(/gi)]
  const values = [
    ...css.matchAll(/\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi),
  ]
  if (tokens.length !== values.length)
    return assetError(label, "contains an invalid CSS resource reference")
  for (const match of values) reference(match[1] ?? match[2] ?? match[3])
}

const validateInlineImage = (
  url: string | undefined,
  label: string,
  depth = 0,
  mimetypeHint?: string,
) => {
  if (!url) return
  const { mimetype, bytes } = decodeDataAsset(url, label)
  const prefix = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart()
  if (
    mimetype === "image/svg+xml" ||
    mimetypeHint?.toLowerCase() === "image/svg+xml" ||
    prefix.startsWith("<")
  ) {
    validateSvgText(decodeAssetText(bytes, label), label, depth)
  }
}

const validateGltfJson = (
  json: unknown,
  label: string,
  binary?: Uint8Array,
) => {
  if (!json || typeof json !== "object" || Array.isArray(json))
    return assetError(label, "has invalid GLTF JSON")
  const document = json as Record<string, unknown>
  if (
    !document.asset ||
    typeof document.asset !== "object" ||
    (document.asset as { version?: unknown }).version !== "2.0"
  ) {
    return assetError(label, "must use GLTF version 2.0")
  }
  const stack = [{ value: json, depth: 0 }]
  let count = 0
  while (stack.length) {
    const { value, depth } = stack.pop()!
    if (++count > 100_000 || depth > 64)
      return assetError(label, "exceeds the GLTF structure limit")
    if (!value || typeof value !== "object") continue
    for (const [key, child] of Object.entries(value)) {
      if (
        UNSUPPORTED_GLTF_DECODERS.has(key) ||
        ((key === "extensionsUsed" || key === "extensionsRequired") &&
          Array.isArray(child) &&
          child.some((name) => UNSUPPORTED_GLTF_DECODERS.has(name)))
      ) {
        return assetError(
          label,
          "requires an unbundled GLTF compression decoder",
        )
      }
      if (key === "uri") {
        if (typeof child !== "string" || !child)
          return assetError(label, "has an invalid GLTF resource URI")
        requireEmbeddedAsset(child, `${label} GLTF resource`)
      }
      stack.push({ value: child, depth: depth + 1 })
    }
  }
  for (const key of ["buffers", "images"] as const) {
    if (document[key] !== undefined && !Array.isArray(document[key]))
      return assetError(label, `has invalid GLTF ${key}`)
  }
  const bufferBytes: Uint8Array[] = []
  for (const [index, value] of (
    (document.buffers as unknown[] | undefined) ?? []
  ).entries()) {
    if (!value || typeof value !== "object")
      return assetError(label, "has an invalid GLTF buffer")
    const buffer = value as { uri?: string; byteLength?: number }
    const bytes = buffer.uri
      ? decodeDataAsset(buffer.uri, `${label} GLTF buffer`).bytes
      : index === 0
        ? binary
        : undefined
    if (
      !bytes ||
      !Number.isInteger(buffer.byteLength) ||
      buffer.byteLength! < 0 ||
      buffer.byteLength! > bytes.length
    ) {
      return assetError(label, "has an unresolved GLTF buffer")
    }
    bufferBytes.push(bytes)
  }
  for (const value of (document.images as unknown[] | undefined) ?? []) {
    if (!value || typeof value !== "object")
      return assetError(label, "has an invalid GLTF image")
    const image = value as {
      uri?: string
      bufferView?: number
      mimeType?: string
    }
    if (
      ["image/ktx2", "image/vnd-ms.dds"].includes(image.mimeType ?? "") ||
      /^(?:data:)(?:image\/ktx2|image\/vnd-ms\.dds)[;,]/i.test(image.uri ?? "")
    ) {
      return assetError(label, "requires an unbundled GLTF image decoder")
    }
    if (image.uri)
      validateInlineImage(image.uri, `${label} GLTF image`, 0, image.mimeType)
    else {
      const view = (
        document.bufferViews as
          | { buffer?: number; byteOffset?: number; byteLength?: number }[]
          | undefined
      )?.[image.bufferView!]
      const bytes = bufferBytes[view?.buffer!]
      const offset = view?.byteOffset ?? 0
      if (
        !bytes ||
        !view ||
        !Number.isInteger(offset) ||
        !Number.isInteger(view.byteLength) ||
        offset < 0 ||
        view.byteLength! < 0 ||
        offset + view.byteLength! > bytes.length
      ) {
        return assetError(label, "has an unresolved GLTF image buffer")
      }
      const imageBytes = bytes.subarray(offset, offset + view.byteLength!)
      const prefix = new TextDecoder()
        .decode(imageBytes.subarray(0, 256))
        .trimStart()
      if (image.mimeType === "image/svg+xml" || prefix.startsWith("<")) {
        validateSvgText(
          decodeAssetText(imageBytes, label),
          `${label} GLTF image`,
          0,
        )
      }
    }
  }
}

const validateGltfAsset = (
  url: string,
  label: string,
  format: "gltf" | "glb",
) => {
  const { bytes } = decodeDataAsset(url, label)
  let jsonBytes = bytes
  let binary: Uint8Array | undefined
  if (format === "glb") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (
      bytes.length < 20 ||
      view.getUint32(0, true) !== 0x46546c67 ||
      view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== bytes.length
    ) {
      return assetError(label, "has an invalid GLB header")
    }
    let offset = 12
    let chunks = 0
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length)
        return assetError(label, "has a truncated GLB chunk")
      const length = view.getUint32(offset, true)
      const type = view.getUint32(offset + 4, true)
      if (length % 4 || offset + 8 + length > bytes.length)
        return assetError(label, "has an invalid GLB chunk length")
      const chunk = bytes.subarray(offset + 8, offset + 8 + length)
      if (chunks === 0 && type === 0x4e4f534a) jsonBytes = chunk
      else if (chunks === 1 && type === 0x004e4942) binary = chunk
      else return assetError(label, "has an unsupported GLB chunk")
      offset += 8 + length
      chunks++
    }
  }
  let json: unknown
  try {
    json = JSON.parse(decodeAssetText(jsonBytes, label))
  } catch {
    return assetError(label, "has invalid GLTF JSON")
  }
  validateGltfJson(json, label, binary)
}

const validateCadAsset = (url: string | undefined, format: string) => {
  if (!url) return
  requireEmbeddedAsset(url, "CAD model asset")
  if (format === "3mf" || format === "wrl") {
    return assetError(
      "CAD model asset",
      `uses inline ${format.toUpperCase()}, whose nested resources are unsupported`,
    )
  }
  if (format === "gltf" || format === "glb")
    validateGltfAsset(url, "CAD model asset", format)
}

/** Asset URLs can trigger viewer requests even for previously rendered JSON. */
export const validateEmbeddedAssets = (circuitJson: AnyCircuitElement[]) => {
  for (const element of circuitJson) {
    if (element.type === "cad_component") {
      for (const [format, url] of Object.entries({
        obj: element.model_obj_url,
        stl: element.model_stl_url,
        "3mf": element.model_3mf_url,
        gltf: element.model_gltf_url,
        glb: element.model_glb_url,
        step: element.model_step_url,
        wrl: element.model_wrl_url,
      })) {
        validateCadAsset(url, format)
      }
      if (element.model_asset) {
        const { url, mimetype, project_relative_path } = element.model_asset
        const mimeFormat: Record<string, string> = {
          "model/gltf+json": "gltf",
          "model/gltf-binary": "glb",
          "model/3mf": "3mf",
          "application/vnd.ms-package.3dmanufacturing-3dmodel+xml": "3mf",
          "model/vrml": "wrl",
          "x-world/x-vrml": "wrl",
        }
        const dataMimetype =
          /^data:([^;,]*)/i.exec(url)?.[1].toLowerCase() ?? ""
        const format =
          mimeFormat[mimetype.toLowerCase()] ??
          mimeFormat[dataMimetype] ??
          /\.(gltf|glb|3mf|wrl)$/i
            .exec(project_relative_path)?.[1]
            .toLowerCase() ??
          "other"
        validateCadAsset(url, format)
      }
    }
    if (element.type === "schematic_graphic") {
      validateInlineImage(
        element.asset?.url,
        "Schematic image asset",
        0,
        element.asset?.mimetype,
      )
      if (element.svg_content)
        validateSvgText(element.svg_content, "Schematic SVG", 0)
    }
    if (element.type === "pcb_silkscreen_graphic") {
      validateInlineImage(
        element.image_asset?.url,
        "Silkscreen image asset",
        0,
        element.image_asset?.mimetype,
      )
    }
    if (element.type === "simulation_pcb_return_current_heatmap") {
      validateInlineImage(
        element.image_asset.url,
        "Simulation heatmap image asset",
      )
    }
  }
}

export const validateAssetsAndPartMisses = (
  circuitJson: AnyCircuitElement[],
) => {
  for (const element of circuitJson) {
    if (
      element.type === "source_part_not_found_warning" ||
      element.type === "external_footprint_load_error" ||
      element.type === "circuit_json_footprint_load_error"
    ) {
      throw new Error(element.message)
    }
  }
  validateEmbeddedAssets(circuitJson)
}

/** Validate every snapshot before a viewer can receive it. */
export const validateStandaloneCircuitJson = (
  circuitJson: AnyCircuitElement[],
) => {
  validateSourceParts(circuitJson)
  validateAssetsAndPartMisses(circuitJson)
}
