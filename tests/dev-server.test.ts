import { afterEach, expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { renderCircuitFile, waitForCircuitWorkerTeardown } from "../lib/build"
import { startStandaloneDevServer } from "../lib/dev-server"
import type { StandaloneDevState as DevState } from "../lib/dev-types"

type DevServer = Awaited<ReturnType<typeof startStandaloneDevServer>>
type SourceResponse = { path: string; source: string; revision: string }

const servers: DevServer[] = []
const directories: string[] = []
const assets = {
  "/": { content: "<!doctype html><title>Local circuit</title>", contentType: "text/html" },
  "/app.js": { content: "console.log('local')", contentType: "text/javascript" },
}

afterEach(async () => {
  try {
    await Promise.all(servers.splice(0).map((server) => server.stop()))
  } finally {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  }
})

const resistorCircuit = (resistance = "1k") =>
  `export default () => <board width="10mm" height="10mm"><resistor name="R1" resistance="${resistance}" footprint="0603"/></board>`

async function createDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "standalone-dev-"))
  directories.push(directory)
  return directory
}

async function createServer(files: Record<string, string> = { "index.tsx": resistorCircuit() }) {
  const directory = await createDirectory()
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true })
    await writeFile(join(directory, path), source)
  }
  const entry = join(directory, "index.tsx")
  const server = await startStandaloneDevServer(entry, {
    projectDir: directory,
    port: 0,
    timeoutMs: 15_000,
    assets,
  })
  servers.push(server)
  return { ...server, directory, entry }
}

async function getJson<T>(url: string, path: string): Promise<T> {
  const response = await fetch(`${url}${path}`)
  expect(response.status).toBe(200)
  return await response.json() as T
}

function postJson(url: string, path: string, body: unknown) {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: { Origin: url, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function waitForState(
  url: string,
  accepts: (state: DevState) => boolean,
): Promise<DevState> {
  const deadline = Date.now() + 20_000
  let latest: DevState | undefined
  while (Date.now() < deadline) {
    latest = await getJson<DevState>(url, "/api/state")
    if (accepts(latest)) return latest
    await Bun.sleep(75)
  }
  throw new Error(`Dev server did not reach the expected state: ${JSON.stringify(latest)}`)
}

const terminalStateAfter = (generation = -1) => (state: DevState) =>
  state.generation > generation && state.status !== "building"

function resistance(state: DevState) {
  const component = state.circuitJson?.find((element) => element.type === "source_component" && element.name === "R1")
  return component && "resistance" in component ? component.resistance : undefined
}

async function saveSource(url: string, source: string, expectedRevision?: string) {
  const current = await getJson<SourceResponse>(url, "/api/source")
  const response = await postJson(url, "/api/source", {
    source,
    expectedRevision: expectedRevision ?? current.revision,
  })
  expect(response.status).toBe(200)
  return await response.json() as SourceResponse
}

test("dev startup renders in memory and serves the original editable source", async () => {
  const source = resistorCircuit()
  const { url, server, directory } = await createServer({ "index.tsx": source })
  expect(new URL(url).hostname).toBe("127.0.0.1")
  expect(server.hostname).toBe("127.0.0.1")
  const state = await waitForState(url, terminalStateAfter())
  expect(state.status).toBe("ready")
  expect(state.entryPath).toBe("index.tsx")
  expect(resistance(state)).toBe(1000)
  expect(state.report?.errors).toEqual([])
  const editable = await getJson<SourceResponse>(url, "/api/source")
  expect(editable.path).toBe("index.tsx")
  expect(editable.source).toBe(source)
  expect(editable.revision).toBe(state.sourceRevision)
  expect(await readdir(directory)).toEqual(["index.tsx"])
  const head = await fetch(`${url}/api/state`, { method: "HEAD" })
  expect(head.status).toBe(200)
  expect(await head.text()).toBe("")
  expect(head.headers.get("content-type")).toContain("application/json")

  const page = await fetch(url)
  expect(await page.text()).toBe(assets["/"].content)
  expect(page.headers.get("cache-control")).toContain("no-store")
  expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'")
  expect(page.headers.get("access-control-allow-origin")).toBeNull()
  const script = await fetch(`${url}/app.js`)
  expect(await script.text()).toBe(assets["/app.js"].content)
  expect((await fetch(`${url}/missing.js`)).status).toBe(404)
}, 30_000)

test("source saves rebuild and stale revisions preserve newer disk changes", async () => {
  const { url, directory, entry } = await createServer()
  const initial = await waitForState(url, terminalStateAfter())
  const previous = await getJson<SourceResponse>(url, "/api/source")
  const updated = await saveSource(url, resistorCircuit("2k"), previous.revision)
  expect(updated.source).toBe(resistorCircuit("2k"))
  expect(updated.revision).not.toBe(previous.revision)
  expect(await readFile(entry, "utf8")).toBe(updated.source)
  const rendered = await waitForState(url, terminalStateAfter(initial.generation))
  expect(rendered.status).toBe("ready")
  expect(resistance(rendered)).toBe(2000)

  const externalSource = resistorCircuit("4.7k")
  await writeFile(entry, externalSource)
  const conflict = await postJson(url, "/api/source", {
    source: resistorCircuit("10k"),
    expectedRevision: updated.revision,
  })
  expect(conflict.status).toBe(409)
  expect(await readFile(entry, "utf8")).toBe(externalSource)
  const external = await waitForState(url, (state) => state.generation > rendered.generation && resistance(state) === 4700 && state.status === "ready")
  expect(external.sourceRevision).not.toBe(updated.revision)
  expect(await readdir(directory)).toEqual(["index.tsx"])
}, 60_000)

test("an initially malformed circuit remains editable and recovers after saving", async () => {
  const invalid = "export default () => <board>"
  const { url, directory } = await createServer({ "index.tsx": invalid })
  const failure = await waitForState(url, terminalStateAfter())
  expect(failure.status).toBe("error")
  expect(failure.error).toBeTruthy()
  expect(failure.circuitJson).toBeUndefined()
  expect((await getJson<SourceResponse>(url, "/api/source")).source).toBe(invalid)
  await saveSource(url, resistorCircuit())
  const recovered = await waitForState(url, terminalStateAfter(failure.generation))
  expect(recovered.status).toBe("ready")
  expect(resistance(recovered)).toBe(1000)
  expect(recovered.error).toBeUndefined()
  expect(await readdir(directory)).toEqual(["index.tsx"])
}, 60_000)

for (const [label, body, message] of [
  ["unknown manufacturer", '<chip name="U1" footprint="qfn8" manufacturerPartNumber="UNBUNDLED_CHIP"/>', "not bundled"],
  ["remote model", '<chip name="U1" footprint="qfn8" cadModel={{objUrl:"https://example.invalid/model.obj"}}/>', "asset"],
] as const) {
  test(`${label} reports a local failure without publishing stale Circuit JSON`, async () => {
    const { url, directory } = await createServer()
    const ready = await waitForState(url, terminalStateAfter())
    expect(ready.status).toBe("ready")
    await saveSource(url, `export default () => <board width="20mm" height="20mm">${body}</board>`)
    const failure = await waitForState(url, terminalStateAfter(ready.generation))
    expect(failure.status).toBe("error")
    expect(failure.error).toContain(message)
    expect(failure.circuitJson).toBeUndefined()
    expect(failure.report).toBeUndefined()
    expect(await readdir(directory)).toEqual(["index.tsx"])
  }, 60_000)
}

test("catalog imports are local, use a fixed path, and refuse unknown parts or overwrites", async () => {
  const { url, directory } = await createServer()
  const catalog = await getJson<{ parts: { supplierPartNumber: string }[] }>(url, "/api/catalog")
  expect(catalog.parts.some((part) => part.supplierPartNumber === "C2040")).toBe(true)
  const unknown = await postJson(url, "/api/import", { supplierPartNumber: "C999999999" })
  expect(unknown.status).toBeGreaterThanOrEqual(400)
  expect(unknown.status).toBeLessThan(500)
  expect(await readdir(directory)).toEqual(["index.tsx"])

  const imported = await postJson(url, "/api/import", { supplierPartNumber: "C2040" })
  expect(imported.status).toBe(201)
  const result = await imported.json() as { path: string; source: string }
  expect(result.path).toBe("imports/C2040.tsx")
  expect(result.source).toContain("RP2040")
  expect(result.source).toContain("qfn56_")
  const importPath = join(directory, result.path)
  expect(await readFile(importPath, "utf8")).toBe(result.source)
  await writeFile(importPath, "// preserve my edited component\n")
  const conflict = await postJson(url, "/api/import", { supplierPartNumber: "C2040" })
  expect(conflict.status).toBe(409)
  expect(await readFile(importPath, "utf8")).toBe("// preserve my edited component\n")
}, 30_000)

test("catalog imports reject an imports directory that escapes through a symlink", async () => {
  const { url, directory } = await createServer()
  const outside = await createDirectory()
  await symlink(outside, join(directory, "imports"))
  const response = await postJson(url, "/api/import", { supplierPartNumber: "C2040" })
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(response.status).toBeLessThan(500)
  expect(await readdir(outside)).toEqual([])
}, 30_000)

test("unsafe hosts, origins, content types, and payloads cannot modify source", async () => {
  const { url, entry } = await createServer()
  const original = await getJson<SourceResponse>(url, "/api/source")
  const validBody = JSON.stringify({ source: resistorCircuit("2k"), expectedRevision: original.revision })
  const hostileHost = await fetch(`${url}/api/source`, { headers: { Host: "attacker.invalid" } })
  expect(hostileHost.status).toBe(403)
  for (const origin of ["https://attacker.invalid", "null", undefined]) {
    const response = await fetch(`${url}/api/source`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(origin === undefined ? {} : { Origin: origin }) },
      body: validBody,
    })
    expect(response.status).toBe(403)
  }
  for (const [contentType, body] of [
    ["text/plain", validBody],
    ["application/json", "{"],
    ["application/json", "null"],
    ["application/json", "[]"],
    ["application/json", JSON.stringify({ source: resistorCircuit("2k"), expectedRevision: original.revision, path: "../outside.tsx" })],
    ["application/json", JSON.stringify({ source: 123, expectedRevision: original.revision })],
  ]) {
    const response = await fetch(`${url}/api/source`, {
      method: "POST",
      headers: { Origin: url, "Content-Type": contentType },
      body,
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  }
  const oversizedSource = await postJson(url, "/api/source", {
    source: "x".repeat(2 * 1024 * 1024 + 1),
    expectedRevision: original.revision,
  })
  expect(oversizedSource.status).toBe(413)
  const oversizedBody = await fetch(`${url}/api/source`, {
    method: "POST",
    headers: { Origin: url, "Content-Type": "application/json" },
    body: "x".repeat(2 * 1024 * 1024 + 64 * 1024 + 1),
  })
  expect(oversizedBody.status).toBe(413)
  expect(await readFile(entry, "utf8")).toBe(original.source)
}, 30_000)

test("dependency edits and atomic file replacements rerender without modifying the entry", async () => {
  const entrySource = `import { value } from './value'; export default () => <board width="10mm" height="10mm"><resistor name="R1" resistance={value} footprint="0603"/></board>`
  const { url, directory, entry } = await createServer({
    "index.tsx": entrySource,
    "value.ts": `export const value = '1k'`,
  })
  const initial = await waitForState(url, terminalStateAfter())
  expect(initial.status).toBe("ready")
  expect(resistance(initial)).toBe(1000)
  await writeFile(join(directory, "value.ts"), `export const value = '2k'`)
  const updated = await waitForState(url, (state) => state.generation > initial.generation && state.status === "ready" && resistance(state) === 2000)
  await writeFile(join(directory, "value.next.ts"), `export const value = '4.7k'`)
  await rename(join(directory, "value.next.ts"), join(directory, "value.ts"))
  const replaced = await waitForState(url, (state) => state.generation > updated.generation && state.status === "ready" && resistance(state) === 4700)
  expect(replaced.sourceRevision).toBe(initial.sourceRevision)
  expect(await readFile(entry, "utf8")).toBe(entrySource)
  expect((await readdir(directory)).sort()).toEqual(["index.tsx", "value.ts"])

  const requested = await postJson(url, "/api/render", {})
  expect(requested.status).toBe(202)
  const building = await requested.json() as DevState
  expect(building.status).toBe("building")
  const rerendered = await waitForState(url, terminalStateAfter(replaced.generation))
  expect(rerendered.status).toBe("ready")
  expect(resistance(rerendered)).toBe(4700)
}, 60_000)

test("edits during worker startup publish only the latest circuit", async () => {
  const { url } = await createServer()
  const initial = await getJson<DevState>(url, "/api/state")
  expect(initial.status).toBe("building")
  await saveSource(url, resistorCircuit("2k"))
  await saveSource(url, resistorCircuit("3k"))
  const current = await waitForState(url, terminalStateAfter(initial.generation))
  expect(current.status).toBe("ready")
  expect(resistance(current)).toBe(3000)
  expect(current.sourceRevision).toBe((await getJson<SourceResponse>(url, "/api/source")).revision)
}, 30_000)

test("a reachable dependency inside build invalidates the preview when edited", async () => {
  const entrySource = `import { value } from './build/value'; export default () => <board width="10mm" height="10mm"><resistor name="R1" resistance={value} footprint="0603"/></board>`
  const { url, directory } = await createServer({
    "index.tsx": entrySource,
    "build/value.ts": `export const value = '1k'`,
  })
  const initial = await waitForState(url, terminalStateAfter())
  expect(initial.status).toBe("ready")
  expect(resistance(initial)).toBe(1000)
  await writeFile(join(directory, "build/value.ts"), `export const value = '6.8k'`)
  const updated = await waitForState(url, (state) => state.generation > initial.generation && state.status === "ready" && resistance(state) === 6800)
  expect(updated.sourceRevision).toBe(initial.sourceRevision)
  expect((await getJson<SourceResponse>(url, "/api/source")).source).toBe(entrySource)
  expect(await readdir(join(directory, "build"))).toEqual(["value.ts"])
}, 60_000)

test("a render timeout reports an error while worker bootstrap cleanup is deferred", async () => {
  const directory = await createDirectory()
  const entry = join(directory, "index.tsx")
  await writeFile(entry, resistorCircuit())
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error("Render timeout did not reject within five seconds")), 5_000)
  })
  try {
    await expect(Promise.race([
      renderCircuitFile(entry, { projectDir: directory, timeoutMs: 1 }),
      deadline,
    ])).rejects.toThrow("exceeded 1 ms")
  } finally {
    clearTimeout(deadlineTimer)
    await waitForCircuitWorkerTeardown()
  }
  const circuitJson = await renderCircuitFile(entry, { projectDir: directory, timeoutMs: 15_000 })
  const component = circuitJson.find((element) => element.type === "source_component" && element.name === "R1")
  expect(component && "resistance" in component ? component.resistance : undefined).toBe(1000)
  expect(await readdir(directory)).toEqual(["index.tsx"])
}, 30_000)

test("a newer edit replaces a blocked render instead of waiting for its timeout", async () => {
  const { url } = await createServer({
    "index.tsx": `export default () => { while (true) {} return <board /> }`,
  })
  const blocked = await getJson<DevState>(url, "/api/state")
  expect(blocked.status).toBe("building")
  await Bun.sleep(2_000)
  const deadline = Date.now() + 10_000
  await saveSource(url, resistorCircuit("3k"))
  const current = await waitForState(url, terminalStateAfter(blocked.generation))
  expect(Date.now()).toBeLessThan(deadline)
  expect(current.status).toBe("ready")
  expect(resistance(current)).toBe(3000)
  await Bun.sleep(300)
  expect((await getJson<DevState>(url, "/api/state")).generation).toBe(current.generation)
}, 30_000)
