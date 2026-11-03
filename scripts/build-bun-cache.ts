import { createHash } from "node:crypto"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { validateBinaryTarget } from "./binary-targets"

/** Prepare a private, release-specific cache, never the developer's global cache. */
export async function buildBunCache() {
  if (Bun.version !== "1.4.4")
    throw new Error("Bundled offline installs require the qualified Bun 1.4.4 runtime")
  const target = process.env.BUN_BUILD_TARGET
  validateBinaryTarget(target)
  const [targetOs, cpu] = target ? target.slice(4).split("-") : [process.platform, process.arch]
  const os = targetOs === "windows" ? "win32" : targetOs
  const base = resolve("build/bun-cache")
  await rm(base, { recursive: true, force: true })
  const project = join(base, "project")
  const cache = join(base, ".cache")
  const home = join(base, "home")
  await Promise.all([project, cache, home].map(path => mkdir(path, { recursive: true })))
  const root = await Bun.file("package.json").json()
  const ui = await Bun.file("ui/package.json").json()
  const roots: Record<string, string> = {
    ...root.dependencies,
    "@types/react": ui.devDependencies["@types/react"],
  }
  await writeFile(join(project, "package.json"), JSON.stringify({
    name: "tscircuit-bundled-dependencies", private: true, dependencies: roots,
  }, null, 2))
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    BUN_INSTALL_CACHE_DIR: cache, BUN_INSTALL_AUTO: "disable",
    BUN_CONFIG_REGISTRY: "https://registry.npmjs.org",
  }
  const run = async (args: string[], cacheDirectory = cache) => {
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: project, env: { ...env, BUN_INSTALL_CACHE_DIR: cacheDirectory }, stdin: "ignore", stdout: "inherit", stderr: "pipe", timeout: 180_000,
    })
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    if (stderr) process.stderr.write(stderr)
    if (status !== 0)
      throw new Error(`Incomplete bundled package cache: ${args.join(" ")}`)
  }
  await run(["install", "--ignore-scripts", "--no-progress", `--os=${os}`, `--cpu=${cpu}`])
  const pack = join(base, "cache.pack")
  await run(["pm", "cache", "pack", pack])
  const verificationCache = join(base, "verification-cache")
  await mkdir(verificationCache)
  await run(["pm", "cache", "unpack", pack], verificationCache)
  await rm(join(project, "node_modules"), { recursive: true, force: true })
  await run(["install", "--offline", "--frozen-lockfile", "--ignore-scripts", `--os=${os}`, `--cpu=${cpu}`], verificationCache)
  const archive = join(base, "cache.pack.gz")
  await Bun.write(archive, Bun.file(pack).stream().pipeThrough(new CompressionStream("gzip")))
  await rm(pack)
  const manifests = (await readdir(cache)).filter(name => name.endsWith(".npm")).sort()
  if (!manifests.length) throw new Error("Bundled cache has no package resolution metadata")
  const modulePath = resolve("lib/generated-bun-cache.ts")
  const assetPath = (path: string) => relative(resolve("lib"), path).split(sep).join("/")
  const hash = createHash("sha256").update(Bun.version).update(`${os}-${cpu}`)
  hash.update(await Bun.file(archive).arrayBuffer().then(bytes => Buffer.from(bytes)))
  const lockfile = join(project, "bun.lock")
  hash.update(await Bun.file(lockfile).text())
  for (const name of manifests) hash.update(await Bun.file(join(cache, name)).arrayBuffer().then(bytes => Buffer.from(bytes)))
  await writeFile(modulePath, [
    '// @ts-nocheck -- generated embedded package-cache assets.',
    `import archive from ${JSON.stringify(assetPath(archive))} with { type: "file" }`,
    `import lockfile from ${JSON.stringify(assetPath(lockfile))} with { type: "file" }`,
    ...manifests.map((name, i) => `import manifest${i} from ${JSON.stringify(assetPath(join(cache, name)))} with { type: "file" }`),
    'export const bundledBunCache: { id: string; runtimeVersion: string; registry: string; archive: string; lockfile: string; manifests: Record<string, string>; roots: Record<string, string> } = {',
    `id: ${JSON.stringify(hash.digest("hex"))}, runtimeVersion: ${JSON.stringify(Bun.version)}, registry: "https://registry.npmjs.org", archive, lockfile,`,
    `roots: ${JSON.stringify(roots)}, manifests: {`,
    ...manifests.map((name, i) => `${JSON.stringify(name)}: manifest${i},`),
    '} }\n',
  ].join("\n"))
  // Include licenses for whole packages shipped in the cache, not just modules
  // referenced by the compiled application's JavaScript graph.
  const inputs: Record<string, object> = {}
  for await (const file of new Bun.Glob("**/package.json").scan({ cwd: join(project, "node_modules"), onlyFiles: true, dot: true })) {
    const path = relative(resolve("."), join(project, "node_modules", file)).split(sep).join("/")
    inputs[path] = { bytes: (await Bun.file(path).stat()).size }
  }
  await writeFile("build/bun-cache-metafile.json", JSON.stringify({ inputs }))
  console.log(`Embedded ${manifests.length} package manifests and ${(Bun.file(archive).size / 1024 / 1024).toFixed(1)} MiB of package cache for ${os}-${cpu}`)
}

if (import.meta.main) await buildBunCache()
