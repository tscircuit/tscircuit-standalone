import { mkdir, mkdtemp } from "node:fs/promises"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { jscdnAssets } from "./generated-jscdn-assets"

export async function setupStandaloneEnvironment() {
  // Bun 1.3's embedded files are readable individually, but not as a directory.
  const directory = await mkdtemp(join(tmpdir(), "tsci-jscdn-"))
  process.once("exit", () =>
    rmSync(directory, { recursive: true, force: true }),
  )
  process.once("SIGINT", () => process.exit(130))
  process.once("SIGTERM", () => process.exit(143))
  for (const [name, embeddedPath] of Object.entries(jscdnAssets)) {
    const destination = join(directory, name)
    await mkdir(dirname(destination), { recursive: true })
    await Bun.write(destination, Bun.file(embeddedPath))
  }
  process.env.TSCIRCUIT_STANDALONE = "1"
  process.env.TSCIRCUIT_JSCDN_DIR = directory
}
