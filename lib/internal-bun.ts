import { fileURLToPath } from "node:url"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, join } from "node:path"
import { bunProjectDirectory, writeBunLauncher } from "./bun-shell"

declare const TSCIRCUIT_STANDALONE_COMPILED: boolean

export function getInternalBunArguments(args: string[]): string[] {
  const compiled =
    typeof TSCIRCUIT_STANDALONE_COMPILED !== "undefined" &&
    TSCIRCUIT_STANDALONE_COMPILED
  return [
    process.execPath,
    ...(compiled
      ? []
      : [fileURLToPath(new URL("../cli/standalone.ts", import.meta.url))]),
    "internal",
    "bun",
    ...args,
  ]
}

export function getInternalBunCommandPrefix(): string {
  return getInternalBunArguments([])
      .map((argument) =>
        process.platform === "win32"
          ? `"${argument}"`
          : `'${argument.replaceAll("'", "'\\''")}'`,
      )
      .join(" ")
}

/** Only this child enters Bun CLI mode; the standalone parent remains an app. */
export async function runInternalBun(args: string[]): Promise<number> {
  const informational = args.length === 1 && ["--version", "-v", "--revision", "--help", "-h"].includes(args[0]!)
  let cleanup = async () => {}
  let cache: string | undefined
  let registry: string | undefined
  const valueFlags = new Set(["--cwd", "--config", "-c", "--registry", "--filter", "--linker", "--backend", "--cpu", "--os", "--env-file"])
  let commandIndex = -1
  for (let i = 0; i < args.length; i++) {
    if (["-e", "--eval", "-p", "--print", "--"].includes(args[i]!)) break
    if (valueFlags.has(args[i]!)) { i++; continue }
    if (!args[i]!.startsWith("-")) { commandIndex = i; break }
  }
  const command = args[commandIndex]
  const packageOperation = ["install", "i", "add", "a", "remove", "rm", "uninstall", "update", "up", "ci", "init"].includes(command ?? "")
  if (!informational) {
    const forbidden = args.find(arg => /^(?:--cache-dir|--no-cache|--force|--prefer-latest|--offline=false|--ignore-scripts=false|--trust)(?:=|$)/.test(arg) || arg === "-f")
    if (forbidden && packageOperation) throw new Error(`Standalone installs use only the bundled cache; ${forbidden} is not supported`)
    const { getBundledBunCache, seedBundledLockfile, bundledPackageSpec, bundledRegistry } = await import("./bundled-bun-cache")
    cache = await getBundledBunCache()
    registry = bundledRegistry
    const directory = await bunProjectDirectory(args)
    if (command === "init") {
      // Bun init performs its own automatic install. The shared CLI only needs
      // package.json here; keep that initialization on our cache-only path.
      if (args.some(arg => !["init", "-y", "--yes"].includes(arg)))
        throw new Error("Use tsci init to create an offline tscircuit project")
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, "package.json"), JSON.stringify({ name: basename(directory), private: true, type: "module" }, null, 2), { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error })
      return 0
    }
    if (command) {
      args = args.map((arg, i) => i > commandIndex && !valueFlags.has(args[i - 1]!) ? bundledPackageSpec(arg) : arg)
      if (!args.includes("--global") && !args.includes("-g")) cleanup = await seedBundledLockfile(directory)
    }
    if (packageOperation) args = ["--offline", "--ignore-scripts", `--cache-dir=${cache}`, `--registry=${registry}`, ...args]
  }
  const directory = informational ? undefined : await mkdtemp(join(tmpdir(), "tsci-bun-launcher-"))
  if (directory) await writeBunLauncher(directory, getInternalBunArguments([]))
  if (directory && cache) await writeFile(join(directory, ".bunfig.toml"), `[install]\noffline = true\nauto = "disable"\n[install.cache]\ndir = ${JSON.stringify(cache)}\n`)
  const child = Bun.spawn([process.execPath, ...args], {
    env: { ...process.env, BUN_BE_BUN: "1", BUN_INSTALL_AUTO: "disable", ...(directory ? { PATH: directory + delimiter + (process.env.PATH ?? ""), XDG_CONFIG_HOME: directory } : {}), ...(cache ? { BUN_INSTALL_CACHE_DIR: cache, BUN_CONFIG_REGISTRY: registry, NPM_CONFIG_IGNORE_SCRIPTS: "true" } : {}) },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const interrupt = () => child.kill("SIGINT")
  const terminate = () => child.kill("SIGTERM")
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  try {
    const status = await child.exited
    if (status !== 0) {
      await cleanup()
      if (packageOperation) console.error("Standalone did not download packages. Required dependencies must be present in this release's bundled cache.")
    }
    return status
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
    if (directory) await rm(directory, { recursive: true, force: true })
  }
}
