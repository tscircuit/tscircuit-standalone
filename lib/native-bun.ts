import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { basename, delimiter, dirname, join, posix } from "node:path"
import { createHash } from "node:crypto"
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

export const isPrivateBun = () =>
  ["bun", "bun.exe"].includes(basename(process.execPath).toLowerCase())

export function nativeCacheDirectory(bundle: EmbeddedBunCache) {
  const root =
    process.env.TSCIRCUIT_CACHE_DIR ??
    (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? homedir(), "tscircuit", "cache")
      : join(
          process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
          "tscircuit",
        ))
  return join(root, `bun-${bundle.bunVersion}-${bundle.id}`)
}

// Keep the launcher outside the extracted cache. On different filesystems a
// hardlink needs a copy fallback; cache that copy instead of repeating it per command.
export async function privateBunDirectory(bundle: EmbeddedBunCache) {
  const info = await stat(process.execPath)
  const executableId = createHash("sha256")
    .update(`${process.execPath}:${info.size}:${info.mtimeMs}`)
    .digest("hex")
    .slice(0, 24)
  return join(
    dirname(nativeCacheDirectory(bundle)),
    "launchers",
    `${bundle.id}-${executableId}`,
  )
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

/** Make normal CLI package-manager discovery find this executable, not a system Bun. */
export async function setupPrivateBun(
  directory: string,
  executable = process.execPath,
) {
  const bin = join(directory, "bin")
  await mkdir(bin, { recursive: true })
  const launcher = join(bin, process.platform === "win32" ? "bun.exe" : "bun")
  if (!(await Bun.file(launcher).exists())) {
    const staging = await mkdtemp(join(bin, ".launcher-"))
    const staged = join(staging, basename(launcher))
    try {
      try {
        await link(executable, staged)
      } catch {
        await copyFile(executable, staged)
      }
      try {
        await rename(staged, launcher)
      } catch (error) {
        if (!(await Bun.file(launcher).exists())) throw error
      }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`
  process.env.npm_config_user_agent = `bun/${Bun.version}`
  return launcher
}

export async function runNativeBun(
  bundle: EmbeddedBunCache,
  args = process.argv.slice(2),
) {
  const command = args[0]
  const informational =
    args.length === 1 &&
    ["--version", "-v", "--revision", "--help", "-h"].includes(command ?? "")
  if (
    !informational &&
    ![
      "install",
      "i",
      "add",
      "a",
      "remove",
      "rm",
      "uninstall",
      "update",
    ].includes(command ?? "")
  ) {
    throw new Error(
      `Standalone's private Bun launcher does not support ${command ?? "an empty command"}`,
    )
  }
  // Force flags before positional arguments (including --), and do not let callers
  // disable offline mode. Lifecycle scripts can perform their own networking.
  if (
    args.some((arg) =>
      /^--(?:no-offline|offline=|no-ignore-scripts|ignore-scripts=)/.test(arg),
    )
  ) {
    throw new Error(
      "Standalone package installation must remain offline with scripts disabled",
    )
  }
  const cache = informational ? undefined : await restoreBunCache(bundle)
  const child = Bun.spawn(
    [
      process.execPath,
      ...(informational
        ? args
        : [command!, "--offline", "--ignore-scripts", ...args.slice(1)]),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BUN_BE_BUN: "1",
        ...(cache ? { BUN_INSTALL_CACHE_DIR: cache } : {}),
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  return child.exited
}
