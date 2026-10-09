import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli } from "../cli/main"

test("import writes the embedded component and refuses to overwrite a user's file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "standalone-cli-"))
  const output = join(dir, "RP2040.tsx")
  let stderr = ""
  const io = { stdout: () => {}, stderr: (message: string) => { stderr += message } }
  try {
    expect(await runCli(["import", "C2040", "--output", output], io)).toBe(0)
    const source = await readFile(output, "utf8")
    expect(source).toContain("qfn56_")
    expect(await runCli(["import", "C2040", "--output", output], io)).toBe(1)
    expect(stderr).toContain("EEXIST")
    expect(await readFile(output, "utf8")).toBe(source)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("unbundled imports and unavailable commands fail without calling global fetch", async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = (() => { requests++; throw new Error("Unexpected network request") }) as unknown as typeof fetch
  const io = { stdout: () => {}, stderr: () => {} }
  try {
    expect(await runCli(["import", "C999999999"], io)).toBe(1)
    expect(await runCli(["dev"], io)).toBe(1)
    expect(requests).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
