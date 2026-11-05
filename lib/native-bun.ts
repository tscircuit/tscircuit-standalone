import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { restoreEmbeddedDirectory, type EmbeddedDirectory } from "./embedded-directory"

export type EmbeddedBunCache = EmbeddedDirectory

export function nativeCacheDirectory(bundle: EmbeddedBunCache) {
  const root =
    process.env.TSCIRCUIT_CACHE_DIR ??
    (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? homedir(), "tscircuit", "cache")
      : join(
          process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
          "tscircuit",
        ))
  return resolve(root, `bun-${bundle.bunVersion}-${bundle.id}`)
}

export function restoreBunCache(bundle: EmbeddedBunCache, destination = nativeCacheDirectory(bundle)) {
  return restoreEmbeddedDirectory(bundle, destination)
}

/** Select the embedded runtime directly; PATH and the user's Bun stay untouched. */
export async function setupNativeBun(
  bundle: EmbeddedBunCache,
  configDirectory: string,
) {
  const cache = await restoreBunCache(bundle)
  const config = join(configDirectory, "bunfig.toml")
  await writeFile(
    config,
    `[install]\noffline = true\nignoreScripts = true\n[install.cache]\ndir = ${JSON.stringify(cache)}\n`,
  )
  process.env.TSCIRCUIT_NODE_RUNTIME = process.execPath
  process.env.TSCIRCUIT_NODE_RUNTIME_ARGS = JSON.stringify([
    `--config=${config}`,
  ])
}
