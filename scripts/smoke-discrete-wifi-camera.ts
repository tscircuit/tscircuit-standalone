import { chromium, type Browser, type Page } from "playwright"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { CircuitJson } from "circuit-json"
import { checkEachPcbTraceNonOverlapping } from "@tscircuit/checks"
import { getFullConnectivityMapFromCircuitJson } from "circuit-json-to-connectivity-map"
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
const renderTimeoutMs = 240_000
const fixture = resolve(import.meta.dir, `../examples/${fixtureName}.tsx`)
const netlist = JSON.parse(await readFile(resolve(import.meta.dir, "../examples/wifi-camera.netlist.json"), "utf8")) as WifiCameraNetlist
await mkdir(join(project, "examples"))
const entry = join(project, "examples", `${fixtureName}.tsx`)
await cp(fixture, entry)
await cp(resolve(import.meta.dir, "../examples/helpers"), join(project, "examples/helpers"), { recursive: true })
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
const connectivityMonitorChecks: { name: string; detected: string }[] = []
const qualificationFailures: { stage: string; error: string }[] = []
const completedViews: string[] = []
const devTrace = join(artifacts, "dev-server.trace")
let devNetworkAttempts: string[] = []

function qualify<T>(stage: string, check: () => T): T | undefined {
  try { return check() } catch (error) {
    qualificationFailures.push({ stage, error: String(error) })
    console.error(`${stage}: ${error}`)
  }
}

async function inspect(stage: string, action: () => Promise<void>) {
  try { await action(); completedViews.push(stage) } catch (error) {
    qualificationFailures.push({ stage, error: String(error) })
    console.error(`${stage}: ${error}`)
    await page?.keyboard.press("Escape").catch(() => {})
  }
}

async function native(name: string, args: string[], expectedExit?: number) {
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
  if (expectedExit !== undefined) assert(exitCode === expectedExit, `${name} exited ${exitCode}, expected ${expectedExit}: ${output}`)
  else qualify(`${name} exit status`, () => assert(exitCode === 0, `${name} exited ${exitCode}: ${output}`))
  assert(networkAttempts.length === 0, `${name} attempted native networking: ${networkAttempts.join("\n")}`)
  return output
}

function assertCamera(state: BrowserCircuitState, stage: string) {
  assert(state.status === "ready" && state.circuitJson, `Bare-chip camera failed: ${state.error}`)
  qualify(`${stage} DRC`, () => assert(state.report?.errors.length === 0, `Bare-chip camera has ${state.report?.errors.length ?? "unknown"} core errors; inspect browser.report.json and browser.circuit.json`))
  const count = (type: string) => state.circuitJson!.filter((element) => element.type === type).length
  browserConnectivity = qualify(`${stage} connectivity`, () => checkDiscreteWifiCamera(state.circuitJson as CircuitJson, netlist)) ?? { passed: false }
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

function selfCheckConnectivityMonitor(circuit: CircuitJson) {
  const rejects = (name: string, edited: CircuitJson, expectedMessage: RegExp) => {
    let detected = ""
    try { checkDiscreteWifiCamera(edited, netlist) } catch (error) { detected = String(error) }
    assert(expectedMessage.test(detected), `Connectivity monitor missed ${name}: ${detected}`)
    connectivityMonitorChecks.push({ name, detected })
  }
  const moved = structuredClone(circuit)
  const route = moved.find((element) => element.type === "pcb_trace")
  assert(route?.type === "pcb_trace", "No PCB route available to qualify connectivity monitoring")
  const endpoint = route.route.find((point) => point.route_type === "wire" && (point.start_pcb_port_id || point.end_pcb_port_id))
  assert(endpoint?.route_type === "wire", "No route pad endpoint available to qualify connectivity monitoring")
  endpoint.x += 1
  rejects("route endpoint displaced from its pad", moved, /ends away from its referenced pad/)
  const omitted = structuredClone(circuit)
  const usbPin = omitted.find((element) => element.type === "source_component" && element.name === "U_MCU")
  assert(usbPin?.type === "source_component", "ESP32-S3 source component is absent")
  const usbPort = omitted.find((element) => element.type === "source_port" && element.source_component_id === usbPin.source_component_id && element.pin_number === 25)
  assert(usbPort?.type === "source_port", "ESP32-S3 USB D- pin is absent")
  usbPort.pin_number = 99
  rejects("USB D- physical pin omitted", omitted, /intended net endpoint is missing/)
  const disconnected = structuredClone(circuit)
  const sourceUsb = disconnected.find((element) => element.type === "source_port" && element.source_component_id === usbPin.source_component_id && element.pin_number === 25)
  assert(sourceUsb?.type === "source_port", "USB D- has no physical source port")
  const pcbUsb = disconnected.find((element) => element.type === "pcb_port" && element.source_port_id === sourceUsb.source_port_id)
  assert(pcbUsb?.type === "pcb_port", "USB D- has no PCB port")
  const withoutUsbRoute = disconnected.filter((element) => element.type !== "pcb_trace" || !element.route.some((point) =>
    point.route_type === "wire" && [point.start_pcb_port_id, point.end_pcb_port_id].includes(pcbUsb.pcb_port_id)))
  rejects("USB D- physical connection unrouted", withoutUsbRoute, /USB_DM has unrouted physical endpoints/)

  // Exercise the actual rendered thermal-via geometry. A correctly owned
  // GND via must pass, while assigning that same copper to VBUS must fail.
  const baselineContacts = checkEachPcbTraceNonOverlapping(circuit, {
    connMap: getFullConnectivityMapFromCircuitJson(circuit),
  })
  assert(baselineContacts.length === 0, "The actual board has accidental PCB trace contacts")
  const ground = circuit.find((element) => element.type === "source_port" && element.source_component_id === usbPin.source_component_id && element.pin_number === 57)
  assert(ground?.type === "source_port", "The MCU exposed pad lost its source ground terminal")
  const groundPad = circuit.find((element) => element.type === "pcb_port" && element.source_port_id === ground.source_port_id)
  assert(groundPad?.type === "pcb_port", "The MCU exposed pad lost its physical ground terminal")
  const thermalVias = circuit.filter((element) => element.type === "pcb_via").filter((via) => via.pcb_port_ids?.includes(groundPad.pcb_port_id))
  assert(thermalVias.length === 9, "The real MCU footprint must retain all nine owned thermal vias")
  const foreign = structuredClone(circuit)
  const foreignVia = foreign.find((element) => element.type === "pcb_via" && element.pcb_via_id === thermalVias[4]!.pcb_via_id)
  const vbus = foreign.find((element) => element.type === "source_net" && element.name === "VBUS")
  assert(foreignVia?.type === "pcb_via" && vbus?.type === "source_net", "The actual thermal-via counterexample lacks VBUS connectivity")
  const vbusTrace = foreign.find((element) => element.type === "source_trace" && element.connected_source_net_ids?.includes(vbus.source_net_id))
  assert(vbusTrace?.type === "source_trace", "The actual thermal-via counterexample lacks a VBUS source trace")
  foreignVia.source_trace_id = vbusTrace.source_trace_id
  foreignVia.pcb_port_ids = []
  foreignVia.subcircuit_connectivity_map_key = vbus.subcircuit_connectivity_map_key
  const foreignContacts = checkEachPcbTraceNonOverlapping(foreign, {
    connMap: getFullConnectivityMapFromCircuitJson(foreign),
  })
  assert(foreignContacts.length > 0 && foreignContacts.every((error) => error.type === "pcb_trace_error" && error.pcb_trace_error_id.endsWith(`_${foreignVia.pcb_via_id}`)), "The PCB checker missed or misattributed a real VBUS-via/GND-trace contact")
  connectivityMonitorChecks.push({ name: "thermal via assigned to VBUS touching ground traces", detected: foreignContacts.map((error) => error.message).join("\n") })
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
  // A DRC failure must remain a failed qualification, while the browser audit
  // still records all ordinary views and downloads for network inspection.
  await native("camera-build", ["build", entry, "--output-dir", join(artifacts, "native-build"), "--timeout-ms", String(renderTimeoutMs)])
  nativeReport = JSON.parse(await readFile(join(artifacts, `native-build/${fixtureName}.report.json`), "utf8"))
  const nativeCircuit = JSON.parse(await readFile(join(artifacts, `native-build/${fixtureName}.json`), "utf8")) as CircuitJson
  const nativeErrors = (nativeReport as { errors: unknown[] }).errors
  qualify("native DRC", () => assert(nativeErrors.length === 0, `Bare-chip camera has ${nativeErrors.length} core errors; inspect native-build/${fixtureName}.report.json`))
  nativeConnectivity = qualify("native connectivity", () => checkDiscreteWifiCamera(nativeCircuit, netlist))
  if (nativeConnectivity) qualify("connectivity monitor calibration", () => selfCheckConnectivityMonitor(nativeCircuit))
  else nativeConnectivity = { passed: false }
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
  let state = await waitForState(page, (next) => next.status !== "building", "the bare-chip Wi-Fi camera", renderTimeoutMs)
  assertCamera(state, "initial browser build")
  await writeFile(join(artifacts, "browser.circuit.json"), JSON.stringify(state.circuitJson, null, 2))
  await writeFile(join(artifacts, "browser.report.json"), JSON.stringify(state.report, null, 2))
  for (const view of ["PCB", "Schematic", "3D"] as const) {
    await inspect(view, async () => {
      await openView(page!, view, "discrete-wifi-camera", state)
      if (view === "Schematic") {
        await inspectImportedComponent(page!, state, "U_MCU")
        await inspectImportedComponent(page!, state, "J_USB_C")
      }
    })
  }
  await inspect("BOM", async () => {
    const bom = await openMoreView(page!, "BOM")
    assert((await bom.innerText()).length > 30, "Bare-chip camera BOM is empty")
    await bom.screenshot({ path: join(artifacts, "discrete-wifi-camera-bom.png") })
  })
  await inspect("Errors", async () => {
    const errors = await openMoreView(page!, "Errors")
    await errors.screenshot({ path: join(artifacts, "discrete-wifi-camera-errors.png") })
  })
  await inspect("Circuit JSON", async () => {
    const json = await openMoreView(page!, "Circuit JSON")
    await json.locator("table").waitFor({ state: "visible" })
    await json.screenshot({ path: join(artifacts, "discrete-wifi-camera-json.png") })
  })

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
  state = await saveSource(page, original, state.generation, renderTimeoutMs)
  assertCamera(state, "browser recovery")
  await page.getByRole("button", { name: "Rebuild", exact: true }).click()
  state = await waitForState(page, (next) => next.generation > state.generation && next.status !== "building", "bare-chip camera rebuild", renderTimeoutMs)
  assertCamera(state, "browser rebuild")
  const downloads = join(artifacts, "downloads")
  await mkdir(downloads, { recursive: true })
  const downloaded = JSON.parse(await downloadArtifact(page, /Download Circuit JSON/i, downloads)) as CircuitJson
  qualify("downloaded connectivity", () => checkDiscreteWifiCamera(downloaded, netlist))
  for (const name of [/Download PCB SVG/i, /Download schematic SVG/i]) {
    const svg = await downloadArtifact(page, name, downloads)
    assert(svg.includes("<svg") && !/(?:href|src)\s*=\s*["']https?:\/\//i.test(svg), "Bare-chip camera SVG requires a remote asset")
  }
  await Bun.sleep(1000)
  assertBrowserEvidence(evidence)
  assert(qualificationFailures.length === 0, `Bare-chip camera qualification failed after collecting browser/network evidence:\n${JSON.stringify(qualificationFailures, null, 2)}`)
  console.log(`Bare-chip Wi-Fi camera passed ${imports.length} CLI catalog imports, native build, physical net checks, six RunFrame views, local part failure/recovery, rebuild and downloads: ${new Set(evidence.requests).size} local resources; zero native network attempts, external browser attempts, or CSP violations.`)
} catch (error) {
  await page?.screenshot({ path: join(artifacts, "browser-failure.png"), fullPage: true }).catch(() => {})
  if (page) await writeFile(join(artifacts, "browser-failure.html"), await page.content()).catch(() => {})
  throw error
} finally {
  clearTimeout(startupTimer)
  await writeFile(join(artifacts, "browser-evidence.json"), JSON.stringify(evidence, null, 2))
  await writeFile(join(artifacts, "circuit-summary.json"), JSON.stringify(circuitSummary ?? null, null, 2))
  await writeFile(join(artifacts, "connectivity.json"), JSON.stringify({ nativeConnectivity, browserConnectivity, connectivityMonitorChecks }, null, 2))
  await writeFile(join(artifacts, "qualification.json"), JSON.stringify({ completedViews, qualificationFailures }, null, 2))
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
