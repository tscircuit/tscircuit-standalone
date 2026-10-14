import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import {
  buildDatasheetCatalog,
  type BuildDatasheetCatalogOptions,
} from "./build-datasheets"
import { normalizeChipName } from "../lib/datasheet-catalog"
import { writeEmbeddedAssets } from "./write-embedded-assets"

export async function buildBakedAssets(
  options: Pick<
    BuildDatasheetCatalogOptions,
    | "apiUrl"
    | "fetch"
    | "log"
    | "concurrency"
    | "requestTimeoutMs"
    | "deadlineMs"
  > & { outputDirectory?: string; modulePath?: string } = {},
) {
  const directory =
    options.outputDirectory ?? resolve("build/baked-asset-server")
  const modulePath =
    options.modulePath ?? resolve("lib/generated-baked-assets.ts")
  await mkdir(dirname(directory), { recursive: true })
  const staging = await mkdtemp(join(dirname(directory), ".baked-assets-"))
  const chipNames = new Set<string>()
  const saveResponse = async (
    path: string,
    query: Record<string, string>,
    body: unknown,
  ) => {
    const params = new URLSearchParams(query)
    params.sort()
    // Match the shared CLI's URL-to-file mapping, including Windows-safe '*'.
    const filename = params.size
      ? `${encodeURIComponent(params.toString()).replace(/\*/g, "%2A")}.json`
      : ""
    const destination = join(staging, "datasheet-api", path, filename)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, `${JSON.stringify(body)}\n`)
  }
  try {
    // Reuse the catalog's bounded downloads and complete-inventory checks, while
    // retaining every API field, even for parts excluded from the compiled catalog.
    await buildDatasheetCatalog({
      ...options,
      outputPath: false,
      async onResponse(path, query, body) {
        await saveResponse(path, query, body)
        if (path === "/datasheets/get") {
          const { datasheet } = body as { datasheet: { chip_name: string } }
          const chipName = normalizeChipName(datasheet.chip_name)
          if (!chipName || chipNames.has(chipName))
            throw new Error(
              `Duplicate or empty normalized chip name: ${chipName}`,
            )
          chipNames.add(chipName)
          await saveResponse(path, { chip_name: chipName }, body)
        }
      },
    })
    await rm(directory, { recursive: true, force: true })
    await rename(staging, directory)
    await writeEmbeddedAssets(directory, modulePath, "bakedAssets")
    const log = options.log ?? console.log
    log(`Prepared ${chipNames.size} baked datasheet responses`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) await buildBakedAssets()
