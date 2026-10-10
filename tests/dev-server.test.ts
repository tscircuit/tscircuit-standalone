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

async function createServer(
  files: Record<string, string> = { "index.tsx": resistorCircuit() },
  entryName = "index.tsx",
) {
  const directory = await createDirectory()
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true })
    await writeFile(join(directory, path), source)
  }
  const entry = join(directory, entryName)
  const server = await startStandaloneDevServer(entry, {
    projectDir: directory,
    port: 0,
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

const mainSource = (state: DevState) =>
  state.mainComponentPath ? state.fsMap?.[state.mainComponentPath] : undefined

const graphContains = (state: DevState, source: string) =>
  Object.values(state.fsMap ?? {}).some((contents) => contents.includes(source))

async function saveSource(url: string, source: string, expectedRevision?: string) {
  const current = await getJson<SourceResponse>(url, "/api/source")
  const response = await postJson(url, "/api/source", {
    source,
    expectedRevision: expectedRevision ?? current.revision,
  })
  expect(response.status).toBe(200)
  return await response.json() as SourceResponse
}

test("dev startup prepares browser-worker source in memory and preserves editable source", async () => {
  const source = resistorCircuit()
  const { url, server, directory } = await createServer({ "index.tsx": source })
  expect(new URL(url).hostname).toBe("127.0.0.1")
  expect(server.hostname).toBe("127.0.0.1")
  const state = await waitForState(url, terminalStateAfter())
  expect(state.status).toBe("ready")
  expect(state.entryPath).toBe("index.tsx")
  expect(state.mainComponentPath).toBe("module-0000.tsx")
  expect(mainSource(state)).toContain(source)
  expect(Object.keys(state.fsMap ?? {})).toEqual(["module-0000.tsx"])
  expect("circuitJson" in state).toBe(false)
  expect("report" in state).toBe(false)
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

test("Circuit JSON entries retain the suffix used by RunFrame's static mode", async () => {
  const { url, directory } = await createServer({ "board.circuit.json": "[]" }, "board.circuit.json")
  const state = await waitForState(url, terminalStateAfter())
  expect(state.status).toBe("ready")
  expect(state.entryPath).toBe("board.circuit.json")
  expect(state.mainComponentPath).toBe("module-0000.circuit.json")
  expect(state.fsMap).toEqual({ "module-0000.circuit.json": "[]" })
  expect((await getJson<SourceResponse>(url, "/api/source")).source).toBe("[]")
  expect(await readdir(directory)).toEqual(["board.circuit.json"])
}, 30_000)

test("static Circuit JSON preserves cached part metadata, embedded images, and inspectable diagnostics", async () => {
  const source = JSON.stringify([
    {
      type: "source_component",
      source_component_id: "source_u1",
      name: "U1",
      ftype: "simple_chip",
      manufacturer_part_number: "RP2040",
      supplier_part_numbers: { jlcpcb: ["C2040"] },
    },
    {
      type: "source_component",
      source_component_id: "source_cached_u2",
      name: "U2",
      ftype: "simple_chip",
      manufacturer_part_number: "CACHED_UNBUNDLED_CHIP",
      supplier_part_numbers: { jlcpcb: ["C999999999"], digikey: ["CACHED-PART"] },
    },
    {
      type: "pcb_footprint_overlap_error",
      pcb_footprint_overlap_error_id: "overlap_1",
      pcb_component_ids: ["pcb_u1", "pcb_u2"],
      error_type: "pcb_footprint_overlap_error",
      message: "Inspect overlapping local footprints",
    },
    {
      type: "source_part_not_found_warning",
      message: "Cached supplier lookup did not find U2",
    },
    {
      type: "external_footprint_load_error",
      message: "Cached footprint loading failed",
    },
    {
      type: "schematic_graphic",
      asset: { url: "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E" },
    },
  ])
  const { url } = await createServer({ "board.circuit.json": source }, "board.circuit.json")
  const state = await waitForState(url, terminalStateAfter())
  expect(state.status).toBe("ready")
  expect(mainSource(state)).toBe(source)
  expect(state.error).toBeUndefined()
  expect("circuitJson" in state).toBe(false)
  expect("report" in state).toBe(false)
}, 30_000)

for (const [label, circuitJson, message] of [
  ["remote CAD model", [{ type: "cad_component", model_obj_url: "https://example.invalid/model.obj" }], "CAD model asset"],
  ["remote schematic image", [{ type: "schematic_graphic", asset: { url: "https://example.invalid/schematic.svg" } }], "Schematic image asset"],
  ["remote silkscreen image", [{ type: "pcb_silkscreen_graphic", image_asset: { url: "https://example.invalid/silkscreen.png" } }], "Silkscreen image asset"],
  ["object entry", { type: "source_component", name: "U1" }, "array"],
  ["invalid array element", [null], "array"],
] as const) {
  test(`static ${label} fails before the source graph reaches the browser and remains editable`, async () => {
    const { url, directory } = await createServer({ "board.circuit.json": "[]" }, "board.circuit.json")
    const initial = await waitForState(url, terminalStateAfter())
    const invalid = JSON.stringify(circuitJson)
    await saveSource(url, invalid)
    const failure = await waitForState(url, terminalStateAfter(initial.generation))
    expect(failure.status).toBe("error")
    expect(failure.error).toContain(message)
    expect(failure.fsMap).toBeUndefined()
    expect(failure.mainComponentPath).toBeUndefined()
    expect((await getJson<SourceResponse>(url, "/api/source")).source).toBe(invalid)
    await saveSource(url, "[]")
    const recovered = await waitForState(url, terminalStateAfter(failure.generation))
    expect(recovered.status).toBe("ready")
    expect(mainSource(recovered)).toBe("[]")
    expect(recovered.error).toBeUndefined()
    expect(await readdir(directory)).toEqual(["board.circuit.json"])
  }, 30_000)
}

test("source saves prepare new browser input and stale revisions preserve newer disk changes", async () => {
  const { url, directory, entry } = await createServer()
  const initial = await waitForState(url, terminalStateAfter())
  const previous = await getJson<SourceResponse>(url, "/api/source")
  const updated = await saveSource(url, resistorCircuit("2k"), previous.revision)
  expect(updated.source).toBe(resistorCircuit("2k"))
  expect(updated.revision).not.toBe(previous.revision)
  expect(await readFile(entry, "utf8")).toBe(updated.source)
  const prepared = await waitForState(url, terminalStateAfter(initial.generation))
  expect(prepared.status).toBe("ready")
  expect(mainSource(prepared)).toContain(updated.source)

  const externalSource = resistorCircuit("4.7k")
  await writeFile(entry, externalSource)
  const conflict = await postJson(url, "/api/source", {
    source: resistorCircuit("10k"),
    expectedRevision: updated.revision,
  })
  expect(conflict.status).toBe(409)
  expect(await readFile(entry, "utf8")).toBe(externalSource)
  const external = await waitForState(url, (state) => state.generation > prepared.generation && mainSource(state)?.includes(externalSource) === true && state.status === "ready")
  expect(external.sourceRevision).not.toBe(updated.revision)
  expect(await readdir(directory)).toEqual(["index.tsx"])
}, 60_000)

test("an initially malformed circuit remains editable and recovers after saving", async () => {
  const invalid = "export default () => <board>"
  const { url, directory } = await createServer({ "index.tsx": invalid })
  const failure = await waitForState(url, terminalStateAfter())
  expect(failure.status).toBe("error")
  expect(failure.error).toBeTruthy()
  expect(failure.fsMap).toBeUndefined()
  expect(failure.mainComponentPath).toBeUndefined()
  expect((await getJson<SourceResponse>(url, "/api/source")).source).toBe(invalid)
  await saveSource(url, resistorCircuit())
  const recovered = await waitForState(url, terminalStateAfter(failure.generation))
  expect(recovered.status).toBe("ready")
  expect(mainSource(recovered)).toContain(resistorCircuit())
  expect(recovered.error).toBeUndefined()
  expect(await readdir(directory)).toEqual(["index.tsx"])
}, 60_000)

for (const [label, specifier] of [
  ["unbundled package", "unbundled-package"],
  ["registry import", "@tsci/unbundled-component"],
  ["Node builtin", "node:fs"],
  ["remote module", "https://example.invalid/component.tsx"],
] as const) {
  test(`${label} reports a local graph failure without publishing stale browser input`, async () => {
    const { url, directory } = await createServer()
    const ready = await waitForState(url, terminalStateAfter())
    expect(ready.status).toBe("ready")
    await saveSource(url, `import Component from '${specifier}'; ${resistorCircuit()}`)
    const failure = await waitForState(url, terminalStateAfter(ready.generation))
    expect(failure.status).toBe("error")
    expect(failure.error).toContain(specifier)
    expect(failure.error).toContain("not bundled")
    expect(failure.fsMap).toBeUndefined()
    expect(failure.mainComponentPath).toBeUndefined()
    expect(await readdir(directory)).toEqual(["index.tsx"])
  }, 60_000)
}

test("catalog imports are local, use a fixed path, and refuse unknown parts or overwrites", async () => {
  const { url, directory } = await createServer()
  const initial = await waitForState(url, terminalStateAfter())
  const catalog = await getJson<{ parts: { supplierPartNumber: string }[] }>(url, "/api/catalog")
  expect(catalog.parts.some((part) => part.supplierPartNumber === "C2040")).toBe(true)
  const unknown = await postJson(url, "/api/import", { supplierPartNumber: "C999999999" })
  expect(unknown.status).toBeGreaterThanOrEqual(400)
  expect(unknown.status).toBeLessThan(500)
  expect(await readdir(directory)).toEqual(["index.tsx"])

  const source = `import { RP2040 } from './imports/C2040'; export default () => <board width="20mm" height="20mm"><RP2040 name="U1" /></board>`
  await saveSource(url, source)
  const missing = await waitForState(url, terminalStateAfter(initial.generation))
  expect(missing.status).toBe("error")
  expect(missing.error).toContain("was not found")

  const imported = await postJson(url, "/api/import", { supplierPartNumber: "C2040" })
  expect(imported.status).toBe(201)
  const result = await imported.json() as { path: string; source: string }
  expect(result.path).toBe("imports/C2040.tsx")
  expect(result.source).toContain("RP2040")
  expect(result.source).toContain("qfn56_")
  const importPath = join(directory, result.path)
  expect(await readFile(importPath, "utf8")).toBe(result.source)
  const ready = await waitForState(url, terminalStateAfter(missing.generation))
  expect(ready.status).toBe("ready")
  expect(Object.keys(ready.fsMap ?? {})).toHaveLength(2)
  expect(mainSource(ready)).toContain('"./module-0001.tsx"')
  expect(graphContains(ready, "Standalone source: imports/C2040.tsx")).toBe(true)
  expect(graphContains(ready, "qfn56_")).toBe(true)
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

test("dependency edits and atomic file replacements update the graph without modifying the entry", async () => {
  const entrySource = `import { value } from './value'; export default () => <board width="10mm" height="10mm"><resistor name="R1" resistance={value} footprint="0603"/></board>`
  const { url, directory, entry } = await createServer({
    "index.tsx": entrySource,
    "value.ts": `export const value = '1k'`,
  })
  const initial = await waitForState(url, terminalStateAfter())
  expect(initial.status).toBe("ready")
  expect(graphContains(initial, "export const value = '1k'")).toBe(true)
  expect(mainSource(initial)).toContain('"./module-0001.ts"')
  expect(Object.keys(initial.fsMap ?? {})).toHaveLength(2)
  await writeFile(join(directory, "value.ts"), `export const value = '2k'`)
  const updated = await waitForState(url, (state) => state.generation > initial.generation && state.status === "ready" && graphContains(state, "export const value = '2k'"))
  await writeFile(join(directory, "value.next.ts"), `export const value = '4.7k'`)
  await rename(join(directory, "value.next.ts"), join(directory, "value.ts"))
  const replaced = await waitForState(url, (state) => state.generation > updated.generation && state.status === "ready" && graphContains(state, "export const value = '4.7k'"))
  expect(replaced.sourceRevision).toBe(initial.sourceRevision)
  expect(await readFile(entry, "utf8")).toBe(entrySource)
  expect((await readdir(directory)).sort()).toEqual(["index.tsx", "value.ts"])

  const requested = await postJson(url, "/api/render", {})
  expect(requested.status).toBe(202)
  const building = await requested.json() as DevState
  expect(building.status).toBe("building")
  const preparedAgain = await waitForState(url, terminalStateAfter(replaced.generation))
  expect(preparedAgain.status).toBe("ready")
  expect(preparedAgain.fsMap).toEqual(replaced.fsMap)
}, 60_000)

test("rapid source edits leave the latest graph ready for the browser worker", async () => {
  const { url } = await createServer()
  const initial = await getJson<DevState>(url, "/api/state")
  await saveSource(url, resistorCircuit("2k"))
  await saveSource(url, resistorCircuit("3k"))
  const current = await waitForState(url, (state) => terminalStateAfter(initial.generation)(state) && mainSource(state)?.includes(resistorCircuit("3k")) === true)
  expect(current.status).toBe("ready")
  expect(mainSource(current)).not.toContain(resistorCircuit("2k"))
  expect(current.sourceRevision).toBe((await getJson<SourceResponse>(url, "/api/source")).revision)
}, 30_000)

test("a reachable dependency inside build invalidates the source graph when edited", async () => {
  const entrySource = `import { value } from './build/value'; export default () => <board width="10mm" height="10mm"><resistor name="R1" resistance={value} footprint="0603"/></board>`
  const { url, directory } = await createServer({
    "index.tsx": entrySource,
    "build/value.ts": `export const value = '1k'`,
  })
  const initial = await waitForState(url, terminalStateAfter())
  expect(initial.status).toBe("ready")
  expect(graphContains(initial, "export const value = '1k'")).toBe(true)
  await writeFile(join(directory, "build/value.ts"), `export const value = '6.8k'`)
  const updated = await waitForState(url, (state) => state.generation > initial.generation && state.status === "ready" && graphContains(state, "export const value = '6.8k'"))
  expect(updated.sourceRevision).toBe(initial.sourceRevision)
  expect((await getJson<SourceResponse>(url, "/api/source")).source).toBe(entrySource)
  expect(await readdir(join(directory, "build"))).toEqual(["value.ts"])
}, 60_000)

test("dev hands circuit code to the browser without executing it on the host", async () => {
  const source = `export default () => { throw new Error('Circuit must run in the browser worker') }`
  const { url, directory } = await createServer({ "index.tsx": source })
  const state = await waitForState(url, terminalStateAfter())
  expect(state.status).toBe("ready")
  expect(mainSource(state)).toContain(source)
  expect(state.error).toBeUndefined()
  expect("circuitJson" in state).toBe(false)
  expect("report" in state).toBe(false)
  expect(await readdir(directory)).toEqual(["index.tsx"])
}, 30_000)
