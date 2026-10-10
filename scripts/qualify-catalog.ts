// Build-time review only. Reference geometry and this dependency stay out of the binary.
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { AnyCircuitElement } from "circuit-json"
import { circuitJsonToFootprint, summarizeCopperComparison } from "circuit-json-to-footprinter"
import { getBundledFootprintCircuitJson, parseBundledPart } from "../lib/catalog"

export const CATALOG_COPPER_IOU_THRESHOLD = 0.98

const installedMetadata = (name: string): { version: string; standaloneSource?: unknown } => {
  let directory = dirname(fileURLToPath(import.meta.resolve(name)))
  while (true) {
    const path = join(directory, "package.json")
    if (existsSync(path)) {
      const metadata = JSON.parse(readFileSync(path, "utf8"))
      if (metadata.name === name && typeof metadata.version === "string") return metadata
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Package metadata missing for ${name}`)
    directory = parent
  }
}

export const qualifyPartReference = (input: unknown, reference: readonly AnyCircuitElement[]) => {
  const part = parseBundledPart(input)
  const compact = getBundledFootprintCircuitJson(part)
  const pads = (elements: readonly AnyCircuitElement[]) =>
    elements.filter(
      (element) => element.type === "pcb_smtpad" || element.type === "pcb_plated_hole",
    )
  const referencePads = pads(reference)
  const compactPads = pads(compact)
  if (!referencePads.length || referencePads.length !== compactPads.length) {
    throw new Error(`${part.supplierPartNumber}: reference and compact copper pad counts differ`)
  }
  // This library may bundle an older Circuit JSON union. Keep compatibility at this boundary.
  const footprint = circuitJsonToFootprint as (
    elements: readonly AnyCircuitElement[],
  ) => ReturnType<typeof circuitJsonToFootprint>
  const metrics = summarizeCopperComparison(footprint(compact), footprint(reference))
  if (!metrics.pinsMatch || metrics.pinMismatches.length) {
    throw new Error(`${part.supplierPartNumber}: physical pin mapping differs from the reference`)
  }
  if (!(metrics.copperIntersectionOverUnion > CATALOG_COPPER_IOU_THRESHOLD)) {
    throw new Error(
      `${part.supplierPartNumber}: copper IoU ${metrics.copperIntersectionOverUnion} must exceed 0.98`,
    )
  }
  if (!(metrics.holeIntersectionOverUnion > CATALOG_COPPER_IOU_THRESHOLD)) {
    throw new Error(
      `${part.supplierPartNumber}: hole IoU ${metrics.holeIntersectionOverUnion} must exceed 0.98`,
    )
  }
  const footprinterMetadata = installedMetadata("@tscircuit/footprinter")
  return {
    supplierPartNumber: part.supplierPartNumber,
    footprint: part.footprint,
    sourcePadCount: referencePads.length,
    compactPadCount: compactPads.length,
    compactRecordBytes: Buffer.byteLength(JSON.stringify(part)),
    ...metrics,
    provenance: part.provenance,
    tools: {
      footprinter: footprinterMetadata.version,
      ...(footprinterMetadata.standaloneSource
        ? { footprinterSource: footprinterMetadata.standaloneSource }
        : {}),
      circuitJsonToFootprinter: installedMetadata("circuit-json-to-footprinter").version,
    },
  }
}

if (import.meta.main) {
  const [manifestPath, outputPath] = process.argv.slice(2)
  if (!manifestPath || process.argv.length > 4) {
    throw new Error("Usage: bun scripts/qualify-catalog.ts <manifest.json> [report.json]")
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    parts: Array<{ part: unknown; referenceFile: string; referenceSha256: string }>
  }
  if (!Array.isArray(manifest.parts) || !manifest.parts.length) {
    throw new Error("Qualification manifest needs a non-empty parts array")
  }
  const reports = []
  for (const entry of manifest.parts) {
    const bytes = await readFile(resolve(dirname(manifestPath), entry.referenceFile))
    const referenceSha256 = createHash("sha256").update(bytes).digest("hex")
    if (
      !/^[a-f0-9]{64}$/.test(entry.referenceSha256) ||
      referenceSha256 !== entry.referenceSha256
    ) {
      throw new Error(`Reference digest differs: ${entry.referenceFile}`)
    }
    reports.push({
      ...qualifyPartReference(entry.part, JSON.parse(bytes.toString()) as AnyCircuitElement[]),
      referenceSha256,
    })
  }
  const report = `${JSON.stringify({ threshold: CATALOG_COPPER_IOU_THRESHOLD, parts: reports }, null, 2)}\n`
  if (outputPath) await writeFile(outputPath, report)
  else process.stdout.write(report)
}
