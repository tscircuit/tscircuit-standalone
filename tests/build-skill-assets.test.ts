import { expect, test } from "bun:test"
import { strToU8, zipSync } from "fflate"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSkillAssets, skillRevision } from "../scripts/build-skill-assets"

test("builds the pinned skill, nested references and license into file imports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "build-skill-"))
  try {
    const prefix = `skill-${skillRevision}/`
    const archive = zipSync({
      [prefix + "SKILL.md"]: strToU8("instructions"),
      [prefix + "LICENSE"]: strToU8("license"),
      [prefix + "elements/board.md"]: strToU8("board reference"),
      [prefix + ".github/workflows/check.yml"]: strToU8("not a skill resource"),
    })
    const urls: string[] = []
    await buildSkillAssets({
      outputDirectory: join(directory, "skill"),
      modulePath: join(directory, "generated.ts"),
      fetch: async (url) => {
        urls.push(String(url))
        return new Response(archive)
      },
    })
    expect(urls).toEqual([`https://codeload.github.com/tscircuit/skill/zip/${skillRevision}`])
    expect(await readFile(join(directory, "skill/elements/board.md"), "utf8")).toBe("board reference")
    expect(await readFile(join(directory, "skill/LICENSE"), "utf8")).toBe("license")
    const generated = await readFile(join(directory, "generated.ts"), "utf8")
    expect(generated).toContain('with { type: "file" }')
    expect(generated).toContain('"elements/board.md"')
    expect(generated).not.toContain(".github")
    expect(JSON.parse(await readFile(join(directory, "skill/SOURCE.json"), "utf8")).revision).toBe(skillRevision)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects missing skill content and archive path traversal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invalid-skill-"))
  try {
    for (const [files, message] of [
      [{ [`skill-${skillRevision}/LICENSE`]: strToU8("license") }, "missing SKILL.md"],
      [{ [`skill-${skillRevision}/../outside`]: strToU8("bad") }, "Invalid skill archive path"],
    ] as const) {
      await expect(buildSkillAssets({
        outputDirectory: join(directory, "skill"),
        modulePath: join(directory, "generated.ts"),
        fetch: async () => new Response(zipSync(files)),
      })).rejects.toThrow(message)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
