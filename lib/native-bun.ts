import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join, posix, resolve } from "node:path"
import { homedir } from "node:os"

export interface EmbeddedBunCache {
  archive: string
  id: string
  bunVersion: string
}
interface CacheMetadata {
  bunVersion: string
  executableFiles: string[]
  links: Record<string, { target: string; directory: boolean }>
}

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

const safeRelative = (name: string) => {
  if (
    !name ||
    name.includes("\\") ||
    name.includes(":") ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid embedded cache path: ${name}`)
  }
  return name
}

export async function restoreBunCache(
  bundle: EmbeddedBunCache,
  destination = nativeCacheDirectory(bundle),
) {
  if (Bun.version !== bundle.bunVersion)
    throw new Error("Embedded cache and Bun runtime versions differ")
  const marker = join(destination, ".tsci-ready")
  if (await Bun.file(marker).exists()) return destination
  await mkdir(dirname(destination), { recursive: true })
  const staging = await mkdtemp(`${destination}.staging-`)
  try {
    // The signed executable supplies the archive; extract only into a fresh directory.
    await new Bun.Archive(Bun.file(bundle.archive)).extract(staging)
    const metadata = JSON.parse(
      await readFile(join(staging, ".tsci-cache.json"), "utf8"),
    ) as CacheMetadata
    if (metadata.bunVersion !== Bun.version)
      throw new Error("Native cache metadata has the wrong Bun version")
    for (const name of metadata.executableFiles)
      await chmod(join(staging, safeRelative(name)), 0o755)
    for (const [name, { target, directory }] of Object.entries(
      metadata.links,
    )) {
      const linkPath = join(staging, safeRelative(name))
      const resolved = safeRelative(
        posix.normalize(posix.join(posix.dirname(name), target)),
      )
      if (
        target.includes("\\") ||
        target.includes(":") ||
        posix.isAbsolute(target)
      )
        throw new Error(`Invalid cache link: ${name}`)
      await mkdir(dirname(linkPath), { recursive: true })
      if (process.platform === "win32") {
        // Junctions don't need developer mode / symlink privileges. Point to the
        // final location so the staged directory can be renamed atomically.
        if (directory)
          await symlink(join(destination, resolved), linkPath, "junction")
        else await copyFile(join(staging, resolved), linkPath)
      } else await symlink(target, linkPath)
    }
    await writeFile(join(staging, ".tsci-ready"), bundle.id)
    try {
      await rename(staging, destination)
    } catch (error) {
      // Another process may have populated this version while we extracted it.
      if (!(await Bun.file(marker).exists())) throw error
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return destination
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
