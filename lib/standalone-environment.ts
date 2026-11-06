import { mkdir, mkdtemp } from "node:fs/promises"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { jscdnAssets } from "./generated-jscdn-assets"
import { bunCache } from "./generated-bun-cache"
import { setupNativeBun } from "./native-bun"
import { restorePackagedRuntime } from "./packaged-runtime"
import { packagedRuntime } from "./generated-runtime"
import { bakedAssets } from "./generated-baked-assets"

export async function setupStandaloneEnvironment() {
  // Extract browser assets for the shared CLI's existing directory interfaces.
  const directory = await mkdtemp(join(tmpdir(), "tsci-standalone-"))
  process.once("exit", () =>
    rmSync(directory, { recursive: true, force: true }),
  )
  const extractAssets = async (
    assets: Record<string, string>,
    subdirectory: string,
  ) => {
    const root = join(directory, subdirectory)
    for (const [name, embeddedPath] of Object.entries(assets)) {
      const destination = join(root, name)
      await mkdir(dirname(destination), { recursive: true })
      await Bun.write(destination, Bun.file(embeddedPath))
    }
    return root
  }
  await setupNativeBun(bunCache, directory)
  const entrypoint = await restorePackagedRuntime(packagedRuntime)
  process.env.TSCIRCUIT_STANDALONE = "1"
  process.env.TSCI_SKIP_CLI_UPDATE = "true"
  process.env.TSCI_TELEMETRY_DISABLED = "true"
  process.env.TSCI_SKIP_SKILL_SETUP = "true"
  process.env.TSCI_SKIP_ACCOUNT_FETCH = "true"
  process.env.TSCIRCUIT_JSCDN_DIR = await extractAssets(jscdnAssets, "jscdn")
  process.env.TSCIRCUIT_BAKED_ASSET_SERVER_DIR = await extractAssets(
    bakedAssets,
    "baked-asset-server",
  )
  process.env.TSCIRCUIT_DEFAULT_SEARCH_SOURCES = "datasheets"
  return entrypoint
}
