import assert from "node:assert/strict"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** Build a tiny genuine Bun cache, including transitive resolution metadata. */
export async function bunCacheFixture(directory: string) {
  const cache = join(directory, "seed-cache")
  const seed = join(directory, "seed-project")
  await Promise.all([cache, seed].map(path => mkdir(path)))
  const archives = new Map<string, Uint8Array>()
  for (const name of ["internal-bun-fixture", "internal-bun-leaf"]) {
    const archive = new Bun.Archive({
      "package/package.json": JSON.stringify({ name, version: "1.0.0", main: "index.js", ...(name === "internal-bun-fixture" ? { dependencies: { "internal-bun-leaf": "^1.0.0" } } : {}) }),
      "package/index.js": name === "internal-bun-fixture" ? 'module.exports = require("internal-bun-leaf")' : "module.exports = 17",
    })
    archives.set(name, Bun.gzipSync(new Uint8Array(await (await archive.blob()).arrayBuffer())))
  }
  const requests: string[] = []
  const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url)
    requests.push(url.pathname)
    const name = url.pathname.replace(/^\/(?:tarballs\/)?/, "").replace(/\.tgz$/, "")
    if (!archives.has(name)) return new Response("Uncached", { status: 404 })
    if (url.pathname.startsWith("/tarballs/")) return new Response(new Uint8Array(archives.get(name)!))
    return Response.json({ name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name, version: "1.0.0", ...(name === "internal-bun-fixture" ? { dependencies: { "internal-bun-leaf": "^1.0.0" } } : {}), dist: { tarball: `${url.origin}/tarballs/${name}.tgz` } } } })
  } })
  const env = { ...process.env, BUN_INSTALL_CACHE_DIR: cache, BUN_CONFIG_REGISTRY: registry.url.origin }
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, ...args], { cwd: seed, env, stdout: "pipe", stderr: "pipe" })
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    assert.equal(status, 0, stdout + stderr)
  }
  try {
    await writeFile(join(seed, "package.json"), JSON.stringify({ name: "seed", private: true, dependencies: { "internal-bun-fixture": "1.0.0" } }))
    await run(["install", "--ignore-scripts"])
    const pack = join(directory, "cache.pack")
    await run(["pm", "cache", "pack", pack])
    const archive = join(directory, "cache.pack.gz")
    await Bun.write(archive, Bun.file(pack).stream().pipeThrough(new CompressionStream("gzip")))
    const manifests = Object.fromEntries((await readdir(cache)).filter(name => name.endsWith(".npm")).map(name => [name, join(cache, name)]))
    requests.length = 0
    return { bundle: { id: "fixture", runtimeVersion: Bun.version, registry: registry.url.origin, archive, lockfile: join(seed, "bun.lock"), manifests, roots: { "internal-bun-fixture": "1.0.0" } }, requests, stop: () => registry.stop(true) }
  } catch (error) { registry.stop(true); throw error }
}
