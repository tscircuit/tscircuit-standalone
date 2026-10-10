import { chromium, type Browser, type Page } from "playwright"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { CircuitJson } from "circuit-json"
import { checkDiscreteWifiCamera, type WifiCameraNetlist } from "./check-discrete-wifi-camera"
import {
  assertBrowserEvidence, createMonitoredPage, downloadArtifact, emptyEvidence,
  expectedAuthoredErrors, openMoreView, openView, saveSource,
  selfCheckWorkerMonitor, waitForState,
  type BrowserCircuitState,
} from "./smoke-dev-browser"

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}
const binary = resolve(process.env.STANDALONE_BINARY ?? "dist/tsci")
const artifacts = resolve(process.env.SMOKE_ARTIFACT_DIR ?? "build/discrete-wifi-camera-evidence")
process.env.SMOKE_ARTIFACT_DIR ??= artifacts
const project = await mkdtemp(join(tmpdir(), "standalone-discrete-camera-"))
const strace = process.env.STRACE_EXECUTABLE_PATH ?? Bun.which("strace")
assert(strace, "Wi-Fi camera qualification requires strace (Linux)")
await mkdir(artifacts, { recursive: true })
const fixtureName = "wifi-camera.circuit"
const fixture = resolve(import.meta.dir, `../examples/${fixtureName}.tsx`)
const netlist = JSON.parse(await readFile(resolve(import.meta.dir, "../examples/wifi-camera.netlist.json"), "utf8")) as WifiCameraNetlist
await mkdir(join(project, "examples"))
const entry = join(project, "examples", `${fixtureName}.tsx`)
await cp(fixture, entry)
const childEnv = {
  PATH: project, BUN_INSTALL_AUTO: "disable",
  HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
}
const evidence = emptyEvidence()
const nativeRuns: { name: string; args: string[]; exitCode: number; output: string; networkAttempts: string[] }[] = []
let browser: Browser | undefined
let page: Page | undefined
let dev: ReturnType<typeof Bun.spawn> | undefined
let readers: Promise<void>[] = []
let devOutput = ""
let startupTimer: ReturnType<typeof setTimeout> | undefined
let nativeReport: unknown
let circuitSummary: unknown
let nativeConnectivity: unknown
let browserConnectivity: unknown
const devTrace = join(artifacts, "dev-server.trace")
let devNetworkAttempts: string[] = []

async function native(name: string, args: string[], expectedExit: number) {
  const trace = join(artifacts, `${name}.trace`)
  const child = Bun.spawn([strace!, "-f", "-e", "trace=network", "-o", trace, binary, ...args], {
    cwd: project, env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  const networkAttempts = (await readFile(trace, "utf8")).split("\n")
    .filter((line) => /socket\(AF_INET6?|connect\(|sendto\(|sendmsg\(/.test(line))
  const output = stdout + stderr
  nativeRuns.push({ name, args, exitCode, output, networkAttempts })
  await writeFile(join(artifacts, `${name}.txt`), output)
  assert(exitCode === expectedExit, `${name} exited ${exitCode}, expected ${expectedExit}: ${output}`)
  assert(networkAttempts.length === 0, `${name} attempted native networking: ${networkAttempts.join("\n")}`)
  return output
}

function assertCamera(state: BrowserCircuitState) {
  assert(state.status === "ready" && state.circuitJson, `Bare-chip camera failed: ${state.error}`)
  assert(state.report?.errors.length === 0, `Bare-chip camera has core errors: ${JSON.stringify(state.report)}`)
  const count = (type: string) => state.circuitJson!.filter((element) => element.type === type).length
  browserConnectivity = checkDiscreteWifiCamera(state.circuitJson as CircuitJson, netlist)
  circuitSummary = { generation: state.generation, elementCounts: Object.fromEntries(
    [...new Set(state.circuitJson.map((element) => element.type))].sort()
      .map((type) => [type, count(type)])),
  }
}

async function inspectImportedComponent(page: Page, state: BrowserCircuitState, name: string) {
  const source = state.circuitJson?.find((element) => element.type === "source_component" && element.name === name)
  const schematic = state.circuitJson?.find((element) => element.type === "schematic_component" && element.source_component_id === source?.source_component_id)
  assert(schematic?.schematic_component_id, `${name} has no schematic body`)
  const component = page.locator(`[data-schematic-component-id=${JSON.stringify(schematic.schematic_component_id)}]`).first()
  await component.hover({ force: true })
  await component.click({ force: true })
  const details = page.getByRole("dialog", { name: `${name} component details`, exact: true })
  await details.waitFor({ state: "visible" })
  assert((await details.innerText()).includes(netlist.importedParts[name]!), `${name} details lost its catalog supplier ID`)
  assert(await details.locator('a[href^="https://jlcpcb.com/"]').count() > 0, `${name} supplier hyperlink is missing`)
  await details.getByRole("status", { name: /price and stock/i }).waitFor({ state: "visible" })
  const thumbnail = details.getByRole("img", { name: /PCB footprint/ })
  await thumbnail.waitFor({ state: "visible" })
  assert((await thumbnail.getAttribute("src"))?.startsWith("data:image/svg+xml"), `${name} thumbnail requires a remote renderer`)
  await details.screenshot({ path: join(artifacts, `${name.toLowerCase()}-details.png`) })
  await page.keyboard.press("Escape")
}

try {
  // Build from generated CLI imports in a project with no package manager or
  // node_modules. Do not copy pre-generated imports alongside the fixture.
  const imports = [...new Set(Object.values(netlist.importedParts))]
  assert(imports.length >= 7, "The bare-chip fixture must exercise seven or more catalog imports")
  for (const part of imports) {
    const output = await native(`import-${part}`, ["import", part, "--output", `examples/imports/${part}.tsx`], 0)
    assert(output.includes(`Imported ${part}`), `${part} was not imported from the bundled catalog`)
    const source = await readFile(join(project, "examples/imports", `${part}.tsx`), "utf8")
    assert(source.includes(part) && source.includes("footprint="), `${part} generated an incomplete component`)
    assert(!/(?:footprint|cadModel)\s*=\s*["']https?:/.test(source), `${part} generated a remote asset dependency`)
  }
  await native("camera-build", ["build", entry, "--output-dir", join(artifacts, "native-build"), "--timeout-ms", "240000"], 0)
  nativeReport = JSON.parse(await readFile(join(artifacts, `native-build/${fixtureName}.report.json`), "utf8"))
  nativeConnectivity = checkDiscreteWifiCamera(JSON.parse(await readFile(join(artifacts, `native-build/${fixtureName}.json`), "utf8")), netlist)
  assert(!(await readdir(project)).includes("node_modules"), "Native build installed project dependencies")

  const devProcess = Bun.spawn([strace, "--kill-on-exit", "-f", "-e", "trace=network", "-o", devTrace,
    binary, "dev", entry, "--port", "0", "--project-dir", project], {
    cwd: project, env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  dev = devProcess
  let ready: (url: string) => void
  let failed: (error: Error) => void
  const startup = new Promise<string>((resolveUrl, reject) => { ready = resolveUrl; failed = reject })
  readers = [devProcess.stdout, devProcess.stderr].map(async (stream) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      devOutput += decoder.decode(value, { stream: true })
      const match = devOutput.match(/RunFrame:\s*(http:\/\/127\.0\.0\.1:\d+)/)
      if (match) ready(match[1]!)
    }
  })
  startupTimer = setTimeout(() => failed(new Error(`Dev startup timed out: ${devOutput}`)), 60_000)
  void dev.exited.then((code) => failed(new Error(`Dev exited ${code}: ${devOutput}`)))
  const origin = await startup
  clearTimeout(startupTimer)
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking",
      "--disable-component-update", "--disable-sync", "--no-first-run",
      "--no-default-browser-check", "--proxy-server=direct://",
      "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  })
  await selfCheckWorkerMonitor(browser)
  page = await createMonitoredPage(browser, origin, evidence)
  assert((await page.goto(origin))?.ok(), "Bare-chip camera RunFrame page failed to load")
  let state = await waitForState(page, (next) => next.status !== "building", "the bare-chip Wi-Fi camera")
  assertCamera(state)
  await writeFile(join(artifacts, "browser.circuit.json"), JSON.stringify(state.circuitJson, null, 2))
  for (const view of ["PCB", "Schematic", "3D"] as const) {
    await openView(page, view, "discrete-wifi-camera", state)
    if (view === "Schematic") {
      await inspectImportedComponent(page, state, "U_MCU")
      await inspectImportedComponent(page, state, "J_USB_C")
    }
  }
  const bom = await openMoreView(page, "BOM")
  assert((await bom.innerText()).length > 30, "Bare-chip camera BOM is empty")
  await bom.screenshot({ path: join(artifacts, "discrete-wifi-camera-bom.png") })
  const errors = await openMoreView(page, "Errors")
  await errors.screenshot({ path: join(artifacts, "discrete-wifi-camera-errors.png") })
  const json = await openMoreView(page, "Circuit JSON")
  await json.locator("table").waitFor({ state: "visible" })
  await json.screenshot({ path: join(artifacts, "discrete-wifi-camera-json.png") })

  const original = await readFile(entry, "utf8")
  const missing = /C999999999999.*not bundled|not bundled.*C999999999999/i
  expectedAuthoredErrors.push(missing)
  state = await saveSource(page,
    'export default () => <board width="40mm" height="40mm"><chip name="U_MISSING" footprint="dip16" supplierPartNumbers={{jlcpcb:["C999999999999"]}}/></board>',
    state.generation)
  assert(state.status === "error" && state.errorOrigin === "worker" && missing.test(state.error ?? ""),
    `An unbundled part did not fail locally: ${JSON.stringify(state)}`)
  const missingView = await openMoreView(page, "Errors")
  assert(missing.test(await missingView.innerText()), "Missing catalog part is absent from RunFrame Errors")
  await page.screenshot({ path: join(artifacts, "discrete-wifi-camera-missing-part.png"), fullPage: true })
  state = await saveSource(page, original, state.generation)
  assertCamera(state)
  await page.getByRole("button", { name: "Rebuild", exact: true }).click()
  state = await waitForState(page, (next) => next.generation > state.generation && next.status !== "building", "bare-chip camera rebuild")
  assertCamera(state)
  const downloads = join(artifacts, "downloads")
  await mkdir(downloads, { recursive: true })
  const downloaded = JSON.parse(await downloadArtifact(page, /Download Circuit JSON/i, downloads)) as CircuitJson
  checkDiscreteWifiCamera(downloaded, netlist)
  for (const name of [/Download PCB SVG/i, /Download schematic SVG/i]) {
    const svg = await downloadArtifact(page, name, downloads)
    assert(svg.includes("<svg") && !/(?:href|src)\s*=\s*["']https?:\/\//i.test(svg), "Bare-chip camera SVG requires a remote asset")
  }
  await Bun.sleep(1000)
  assertBrowserEvidence(evidence)
  console.log(`Bare-chip Wi-Fi camera passed ${imports.length} CLI catalog imports, native build, physical net checks, six RunFrame views, local part failure/recovery, rebuild and downloads: ${new Set(evidence.requests).size} local resources; zero native network attempts, external browser attempts, or CSP violations.`)
} catch (error) {
  await page?.screenshot({ path: join(artifacts, "browser-failure.png"), fullPage: true }).catch(() => {})
  if (page) await writeFile(join(artifacts, "browser-failure.html"), await page.content()).catch(() => {})
  throw error
} finally {
  clearTimeout(startupTimer)
  await writeFile(join(artifacts, "browser-evidence.json"), JSON.stringify(evidence, null, 2))
  await writeFile(join(artifacts, "circuit-summary.json"), JSON.stringify(circuitSummary ?? null, null, 2))
  await writeFile(join(artifacts, "connectivity.json"), JSON.stringify({ nativeConnectivity, browserConnectivity }, null, 2))
  await browser?.close()
  dev?.kill()
  if (dev) {
    await Promise.race([dev.exited, Bun.sleep(2000)])
    if (dev.exitCode === null) dev.kill("SIGKILL")
    await dev.exited
    await Promise.all(readers)
    // The dev server must listen and reply on loopback. Any outbound connect
    // or destination-bearing send elsewhere is a failure, including failures
    // that a dead proxy or the surrounding network namespace would prevent.
    devNetworkAttempts = (await readFile(devTrace, "utf8")).split("\n").filter((line) =>
      /connect\(|sendto\(|sendmsg\(/.test(line) && /AF_INET6?/.test(line) &&
      !/inet_addr\("127\.[0-9.]+"\)|inet_pton\(AF_INET6, "::1"/.test(line))
  }
  await writeFile(join(artifacts, "native-evidence.json"), JSON.stringify({ nativeRuns, nativeReport, devNetworkAttempts }, null, 2))
  await writeFile(join(artifacts, "dev-output.txt"), devOutput)
  await rm(project, { recursive: true, force: true })
  assert(devNetworkAttempts.length === 0, `Dev server attempted outbound networking: ${devNetworkAttempts.join("\n")}`)
}
