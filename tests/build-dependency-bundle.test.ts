import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unzipSync, strFromU8 } from "fflate"
import { dependencyBundleNotices } from "../scripts/dependency-bundle-notices"
import { packDependencyBundle } from "../scripts/build-dependency-bundle"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "dependency-bundle-"))
  directories.push(dir)
  await mkdir(join(dir, "node_modules/example"), { recursive: true })
  await mkdir(join(dir, "node_modules/.bin"), { recursive: true })
  await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { example: "1.2.3" } }))
  await writeFile(join(dir, "bun.lock"), "fixture resolution")
  await writeFile(join(dir, "node_modules/example/package.json"), JSON.stringify({ name: "example", version: "1.2.3" }))
  await writeFile(join(dir, "node_modules/example/cli.js"), "#!/usr/bin/env node\nconsole.log('example')\n", { mode: 0o755 })
  return { dir, output: join(dir, "dependencies.zip") }
}

test("packs exact versions, file integrity, executable links and the resolution lock", async () => {
  const { dir, output } = await fixture()
  await symlink("../example/cli.js", join(dir, "node_modules/.bin/example"))
  await writeFile(join(dir, "node_modules/example/LICENSE"), "Fixture license")
  const manifest = await packDependencyBundle(dir, output)
  expect(manifest.packages.example).toBe("1.2.3")
  expect(manifest.files["example/cli.js"]!.executable).toBe(true)
  expect(manifest.links[".bin/example"]).toBe("../example/cli.js")
  const files = unzipSync(await readFile(output))
  expect(strFromU8(files["bun.lock"]!)).toBe("fixture resolution")
  expect(JSON.parse(strFromU8(files["manifest.json"]!))).toEqual(manifest)
  const inventory = dependencyBundleNotices(await readFile(output))
  expect(inventory[0]!.name).toBe("example")
  expect(inventory[0]!.notices[0]!.content).toBe("Fixture license")
  const first = await readFile(output)
  await packDependencyBundle(dir, output)
  expect(await readFile(output)).toEqual(first)
})

test("rejects host directory links", async () => {
  const { dir, output } = await fixture()
  await symlink("../example", join(dir, "node_modules/alias"))
  await expect(packDependencyBundle(dir, output)).rejects.toThrow("Nonportable package link")
})

test("rejects dependencies that were not installed at the exact starter version", async () => {
  const { dir, output } = await fixture()
  await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { example: "latest" } }))
  await expect(packDependencyBundle(dir, output)).rejects.toThrow("not exactly pinned")
})
