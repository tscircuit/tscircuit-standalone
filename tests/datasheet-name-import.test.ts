import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runCli } from "../cli/main"
import { getBundledPart, getBundledPartFileName } from "../lib/catalog"
import { startStandaloneDevServer } from "../lib/dev-server"

test("manufacturer-name imports write a safe default filename without inventing a supplier number", async () => {
  const directory = await mkdtemp(join(tmpdir(), "standalone-datasheet-cli-"))
  const part = getBundledPart("ESP32-S3R8")
  const filename = `${getBundledPartFileName(part)}.tsx`
  try {
    expect(part.supplierPartNumber).toBeUndefined()
    expect(filename).toMatch(/^[A-Za-z][A-Za-z0-9_]*\.tsx$/)
    expect(filename).not.toContain("-")
    const cliPath = fileURLToPath(new URL("../cli/main.ts", import.meta.url))
    const child = Bun.spawn([process.execPath, cliPath, "import", "esp32-s3r8"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain(`Imported ESP32-S3R8 to imports/${filename}`)
    expect(await readdir(join(directory, "imports"))).toEqual([filename])
    const source = await readFile(join(directory, "imports", filename), "utf8")
    expect(source).toContain(`export const ${part.componentName}`)
    expect(source).toContain('manufacturerPartNumber={"ESP32-S3R8"}')
    expect(source).not.toContain("supplierPartNumbers")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

test("manufacturer names and supplier aliases import locally, while unknown names make no lookup request", async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = (() => {
    requests++
    throw new Error("Unexpected network lookup")
  }) as unknown as typeof fetch
  let stdout = ""
  let stderr = ""
  const io = {
    stdout: (message: string) => {
      stdout += message
    },
    stderr: (message: string) => {
      stderr += message
    },
  }
  try {
    expect(await runCli(["import", "rp2040", "--output", "-"], io)).toBe(0)
    const manufacturerSource = stdout
    stdout = ""
    expect(await runCli(["import", "C2040", "--output", "-"], io)).toBe(0)
    expect(stdout).toBe(manufacturerSource)
    stdout = ""
    expect(await runCli(["catalog", "esp32-s3r8"], io)).toBe(0)
    expect(JSON.parse(stdout).manufacturerPartNumber).toBe("ESP32-S3R8")
    expect(
      await runCli(["import", "UNKNOWN-MANUFACTURER-PART", "--output", "-"], io),
    ).toBe(1)
    expect(stderr).toContain("No network lookup was attempted")
    expect(requests).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("dev imports accept manufacturer names and existing supplier requests without relaxing body validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "standalone-datasheet-dev-"))
  const entry = join(directory, "index.tsx")
  await writeFile(entry, 'export default () => <board width="10mm" height="10mm" />')
  const server = await startStandaloneDevServer(entry, {
    projectDir: directory,
    port: 0,
    assets: {
      "/": { content: "<!doctype html><title>Test</title>", contentType: "text/html" },
    },
  })
  const post = (body: unknown) =>
    fetch(`${server.url}/api/import`, {
      method: "POST",
      headers: { Origin: server.url, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  try {
    const manufacturer = await post({ partNumber: "ESP32-S3R8" })
    expect(manufacturer.status).toBe(201)
    const imported = (await manufacturer.json()) as { path: string; source: string }
    const filename = `${getBundledPartFileName(getBundledPart("ESP32-S3R8"))}.tsx`
    expect(imported.path).toBe(`imports/${filename}`)
    expect(await readFile(join(directory, imported.path), "utf8")).toBe(imported.source)
    const supplier = await post({ supplierPartNumber: "C2040" })
    expect(supplier.status).toBe(201)
    expect(((await supplier.json()) as { path: string }).path).toBe("imports/C2040.tsx")
    await writeFile(join(directory, imported.path), "// preserve edits\n")
    expect((await post({ partNumber: "ESP32-S3R8" })).status).toBe(409)
    expect(await readFile(join(directory, imported.path), "utf8")).toBe(
      "// preserve edits\n",
    )
    for (const body of [
      {},
      { partNumber: "C2040", supplierPartNumber: "C2040" },
      { partNumber: "C2040", path: "../outside.tsx" },
      { partNumber: 2040 },
      { supplierPartNumber: null },
    ]) {
      expect((await post(body)).status).toBe(400)
    }
    expect((await post({ partNumber: "UNKNOWN-MANUFACTURER-PART" })).status).toBe(404)
    expect((await readdir(join(directory, "imports"))).sort()).toEqual(
      ["C2040.tsx", filename].sort(),
    )
  } finally {
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
