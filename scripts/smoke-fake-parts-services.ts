import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startFakePartsServices } from "../lib/fake-parts-services"
import { copySearchCatalogs } from "./build-search-catalogs"

const directory = await mkdtemp(join(tmpdir(), "standalone-api-smoke-"))
await copySearchCatalogs(directory)
await mkdir(join(directory, "datasheet-api/datasheets"), { recursive: true })
await writeFile(
  join(directory, "datasheet-api/datasheets/list"),
  JSON.stringify({ datasheets: [] }),
)
const services = await startFakePartsServices(directory)
try {
  const entrypoint =
    process.env.TSCIRCUIT_CLI_ENTRYPOINT ??
    fileURLToPath(import.meta.resolve("@tscircuit/cli"))
  for (const query of [
    "tps63001",
    "mspm0g3507",
    "C14663",
    "no-such-part-987654321",
  ]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        resolve(import.meta.dir, "../tests/helpers/offline-fetch-preload.ts"),
        entrypoint,
        "search",
        query,
        "--json",
      ],
      {
        env: {
          ...process.env,
          ...services.env,
          TSCIRCUIT_BAKED_ASSET_SERVER_DIR: undefined,
          TSCIRCUIT_DEFAULT_SEARCH_SOURCES:
            "jlcpcb,ti,digikey,mouser,kicad,tscircuit,datasheets",
          TSCI_TEST_MODE: "true",
          TSCI_SKIP_SKILL_SETUP: "true",
          TSCI_SKIP_CLI_UPDATE: "true",
          TSCI_SKIP_ACCOUNT_FETCH: "true",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code || stderr) throw new Error(`${query}: ${code} ${stderr}`)
    const result = JSON.parse(stdout)
    if (result.errors) throw new Error(JSON.stringify(result.errors))
    if (["tps63001", "mspm0g3507"].includes(query)) {
      for (const source of ["ti", "digikey", "mouser"]) {
        if (
          !result.results.some(
            (row: { source: string; mfr?: string }) =>
              row.source === source && row.mfr?.toLowerCase().startsWith(query),
          )
        )
          throw new Error(`Missing ${source}: ${query}`)
      }
    }
    if (
      query === "C14663" &&
      !result.results.some((row: { lcsc?: number }) => row.lcsc === 14663)
    )
      throw new Error("Missing common JLC component")
    if (query === "no-such-part-987654321" && result.results.length)
      throw new Error("Unexpected result for missing part")
    console.log(
      `${query}: ${result.results.length} results from fake APIs, external fetch blocked`,
    )
  }
} finally {
  await services.stop()
  await rm(directory, { recursive: true, force: true })
}
