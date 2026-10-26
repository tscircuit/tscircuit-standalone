import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { cliPackageAdapters } from "../scripts/cli-package-adapters"
import { adaptStandaloneInit, adaptStandaloneSkillSetup } from "../scripts/standalone-init-adapters"

test("standalone init skips account lookup and package installation in the pinned CLI", async () => {
  const original = await readFile("node_modules/@tscircuit/cli/cli/init/register.ts", "utf8")
  const source = adaptStandaloneInit(original)
  expect(source).not.toContain("await fetchAccount()")
  expect(source).toContain("await setupTsciProject(projectDir, [])")
  expect(() => adaptStandaloneInit(source)).toThrow("Pinned CLI init source changed")
  expect(() => adaptStandaloneSkillSetup("changed upstream implementation")).toThrow("Pinned CLI init source changed")
})

test("the actual skill installer copies bundled files for both agents without fetching and preserves existing skills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "offline-init-"))
  const previousDirectory = process.env.TSCIRCUIT_STANDALONE_SKILL_DIR
  const previousFetch = globalThis.fetch
  let requests = 0
  try {
    const bundled = join(directory, "bundled")
    await mkdir(join(bundled, "elements"), { recursive: true })
    await writeFile(join(bundled, "SKILL.md"), "Bundled instructions")
    await writeFile(join(bundled, "elements/board.md"), "Bundled board reference")
    await writeFile(join(bundled, "LICENSE"), "Bundled license")
    process.env.TSCIRCUIT_STANDALONE_SKILL_DIR = bundled
    globalThis.fetch = Object.assign(() => {
      requests++
      throw new Error("Network access is forbidden in this test")
    }, { preconnect: previousFetch.preconnect }) as typeof fetch
    const result = await Bun.build({
      entrypoints: [resolve("node_modules/@tscircuit/cli/lib/shared/setup-tscircuit-skill.ts")],
      outdir: join(directory, "output"),
      target: "bun",
      tsconfig: "node_modules/@tscircuit/cli/tsconfig.json",
      plugins: [cliPackageAdapters],
    })
    if (!result.success) throw new AggregateError(result.logs, "Cannot bundle the skill installer")
    const { setupTscircuitSkill } = await import(result.outputs[0]!.path)
    const project = join(directory, "project")
    const existing = join(project, ".claude/skills/tscircuit")
    await mkdir(existing, { recursive: true })
    await writeFile(join(existing, "SKILL.md"), "User's existing instructions")
    expect(await setupTscircuitSkill(project, true)).toBe(true)
    expect(await readFile(join(existing, "SKILL.md"), "utf8")).toBe("User's existing instructions")
    for (const name of ["SKILL.md", "elements/board.md", "LICENSE"]) {
      expect(await readFile(join(project, ".agents/skills/tscircuit", name), "utf8"))
        .toBe(await readFile(join(bundled, name), "utf8"))
    }
    expect(await setupTscircuitSkill(project, true)).toBe(true)
    expect(requests).toBe(0)
  } finally {
    globalThis.fetch = previousFetch
    if (previousDirectory === undefined) delete process.env.TSCIRCUIT_STANDALONE_SKILL_DIR
    else process.env.TSCIRCUIT_STANDALONE_SKILL_DIR = previousDirectory
    await rm(directory, { recursive: true, force: true })
  }
})
