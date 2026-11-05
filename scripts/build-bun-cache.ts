import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import packageMetadata from "../package.json"
import { packDirectory } from "./pack-directory"

const portable = (path: string) => path.split(sep).join("/")

async function run(args: string[], cwd: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd, env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  })
  if (await child.exited !== 0) throw new Error("Package preparation failed: " + args.join(" "))
}

async function writeBundle(output: string, generated: string, exportName: string, extra: Record<string, string> = {}) {
  const id = createHash("sha256").update(await Bun.file(output).bytes()).digest("hex")
  const file = portable(relative(resolve("lib"), output))
  await writeFile(generated, [
    "// @ts-nocheck -- generated embedded file import",
    "import archive from " + JSON.stringify(file) + ' with { type: "file" }',
    "export const " + exportName + " = { archive, ..."+ JSON.stringify({ id, bunVersion: Bun.version, ...extra }) + " }",
    "",
  ].join("\n"))
}

/** Prepare normal package files and Bun's native cache without transforming either. */
export async function buildBunCache() {
  const expected = (await Bun.file(".bun-version").text()).trim()
  if (Bun.version !== expected) throw new Error("Build the cache with Bun " + expected + ", got " + Bun.version)
  const staging = await realpath(await mkdtemp(join(tmpdir(), "tsci-cache-build-")))
  const cache = join(staging, "cache")
  const runtime = join(staging, "runtime")
  const seed = join(staging, "project")
  const env = {
    ...process.env,
    BUN_INSTALL_CACHE_DIR: cache,
    TSCI_SKIP_CLI_UPDATE: "true",
    TSCI_TELEMETRY_DISABLED: "true",
    TSCI_SKIP_SKILL_SETUP: "true",
    TSCI_SKIP_ACCOUNT_FETCH: "true",
    TSCIRCUIT_CONFIG_DIR: join(staging, "config"),
    TSCIRCUIT_NODE_RUNTIME: process.execPath,
  }
  await mkdir("build/bun-cache-locks", { recursive: true })
  try {
    await mkdir(runtime)
    await writeFile(join(runtime, "package.json"), JSON.stringify({
      name: packageMetadata.name + "-runtime",
      version: packageMetadata.version,
      private: true,
      type: "module",
      dependencies: packageMetadata.dependencies,
    }, null, 2) + "\n")
    await run(["install", "--os=*", "--cpu=*"], runtime, env)
    const entrypoint = await realpath(Bun.resolveSync("@tscircuit/cli", runtime))
    await Bun.write("build/bun-cache-locks/runtime.lock", Bun.file(join(runtime, "bun.lock")))

    // The CLI owns its generated project's dependency requirements.
    await run([entrypoint, "init", seed, "--yes", "--no-install"], runtime, env)
    await run(["install", "--ignore-scripts", "--os=*", "--cpu=*"], seed, env)
    await Bun.write("build/bun-cache-locks/init.lock", Bun.file(join(seed, "bun.lock")))
    await Bun.write("build/bun-cache-locks/init.package.json", Bun.file(join(seed, "package.json")))

    const runtimeOutput = resolve("build/runtime.tar.gz")
    await packDirectory(runtime, runtimeOutput)
    await writeBundle(runtimeOutput, "lib/generated-runtime.ts", "packagedRuntime", {
      entrypoint: portable(relative(runtime, entrypoint)),
    })
    const cacheOutput = resolve("build/bun-cache.tar.gz")
    await packDirectory(cache, cacheOutput)
    await writeBundle(cacheOutput, "lib/generated-bun-cache.ts", "bunCache")
    console.log("Prepared unchanged runtime files (" + Bun.file(runtimeOutput).size + " compressed bytes) and Bun cache (" + Bun.file(cacheOutput).size + " compressed bytes)")
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) await buildBunCache()
