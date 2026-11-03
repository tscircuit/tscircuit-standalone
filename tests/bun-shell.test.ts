import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isTscircuitProject } from "../lib/bun-shell"

test("Bun routing is scoped to tscircuit projects, descendants, and --cwd targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "tsci-shell-scope-"))
  try {
    const project = join(root, "project")
    const outside = join(root, "outside")
    const nested = join(project, "nested")
    await Promise.all([nested, outside].map(path => mkdir(path, { recursive: true })))
    expect(await isTscircuitProject(["--cwd", outside, "install"])).toBe(false)
    await writeFile(join(project, "package.json"), JSON.stringify({ devDependencies: { tscircuit: "latest" } }))
    expect(await isTscircuitProject(["--cwd", nested, "install"])).toBe(true)
    expect(await isTscircuitProject([`--cwd=${project}`, "add", "react"])).toBe(true)
    expect(await isTscircuitProject(["--cwd", project, "--cwd", outside, "install"])).toBe(false)
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "ordinary-project" }))
    expect(await isTscircuitProject(["--cwd", nested, "install"])).toBe(false)
    await writeFile(join(project, "tscircuit.config.json"), "{}")
    expect(await isTscircuitProject(["--cwd", nested, "install"])).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
