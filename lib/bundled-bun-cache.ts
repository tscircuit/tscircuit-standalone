import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { bundledBunCache } from "./generated-bun-cache"

let extraction: Promise<string> | undefined

export const bundledRegistry = bundledBunCache.registry

export function bundledPackageSpec(spec: string): string {
  const version = bundledBunCache.roots[spec]
  return version ? `${spec}@${version}` : spec
}

export function getBundledBunCache(): Promise<string> {
  return extraction ??= extract()
}

async function extract(): Promise<string> {
  if (Bun.version !== bundledBunCache.runtimeVersion || Bun.version !== "1.4.4")
    throw new Error("Offline package installation requires the qualified bundled Bun 1.4.4 runtime")
  const base = process.env.TSCIRCUIT_CACHE_DIR ||
    (process.platform === "win32" ? process.env.LOCALAPPDATA : undefined) ||
    (process.env.XDG_CACHE_HOME && isAbsolute(process.env.XDG_CACHE_HOME) ? process.env.XDG_CACHE_HOME : undefined) ||
    join(homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache")
  const parent = join(base, "tscircuit", "bun")
  const directory = join(parent, bundledBunCache.id)
  const ready = async () => (await readFile(join(directory, ".complete"), "utf8").catch(() => "")) === bundledBunCache.id
  if (await ready()) return directory
  await mkdir(parent, { recursive: true })
  const staging = await mkdtemp(join(parent, ".extract-"))
  try {
    const pack = join(staging, "cache.pack")
    const cache = join(staging, ".cache")
    await mkdir(cache)
    await Bun.write(pack, Bun.file(bundledBunCache.archive).stream().pipeThrough(new DecompressionStream("gzip")))
    const child = Bun.spawn([process.execPath, "pm", "cache", "unpack", pack], {
      cwd: staging,
      env: { ...process.env, BUN_BE_BUN: "1", BUN_INSTALL_CACHE_DIR: cache },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (status !== 0) throw new Error(`Could not extract the bundled package cache: ${stdout}${stderr}`)
    for (const [name, asset] of Object.entries(bundledBunCache.manifests))
      await Bun.write(join(cache, name), Bun.file(asset))
    await writeFile(join(cache, ".complete"), bundledBunCache.id)
    await rename(cache, directory).catch(async error => { if (!await ready()) throw error })
    return directory
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Seed URL/git resolution as well as registry metadata for a fresh project. */
export async function seedBundledLockfile(directory: string): Promise<() => Promise<void>> {
  const lockfile = join(directory, "bun.lock")
  for (let parent = directory;; parent = dirname(parent)) {
    if (await Bun.file(join(parent, "bun.lock")).exists() || await Bun.file(join(parent, "bun.lockb")).exists()) return async () => {}
    if (dirname(parent) === parent) break
  }
  const content = await Bun.file(bundledBunCache.lockfile).text()
  await writeFile(lockfile, content, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error })
  return async () => {
    if (await readFile(lockfile, "utf8").catch(() => "") === content)
      await rm(lockfile, { force: true })
  }
}
