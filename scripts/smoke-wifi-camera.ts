import { chromium, type Browser, type Page } from "playwright"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { CircuitJson } from "circuit-json"
import { checkWifiCamera } from "./check-wifi-camera"
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
const artifacts = resolve(process.env.SMOKE_ARTIFACT_DIR ?? "build/wifi-camera-evidence")
process.env.SMOKE_ARTIFACT_DIR ??= artifacts
const project = await mkdtemp(join(tmpdir(), "standalone-wifi-camera-"))
const strace = process.env.STRACE_EXECUTABLE_PATH ?? Bun.which("strace")
assert(strace, "Wi-Fi camera qualification requires strace (Linux)")
await mkdir(artifacts, { recursive: true })
await cp(resolve(import.meta.dir, "../examples"), join(project, "examples"), { recursive: true })
const entry = join(project, "examples/wifi-camera-carrier.circuit.tsx")
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

function assertCarrier(state: BrowserCircuitState) {
  assert(state.status === "ready" && state.circuitJson, `Carrier failed: ${state.error}`)
  assert(state.report?.errors.length === 0, `Carrier has core errors: ${JSON.stringify(state.report)}`)
  const count = (type: string) => state.circuitJson!.filter((element) => element.type === type).length
  assert(count("pcb_plated_hole") >= 16, "Carrier lost its module socket holes")
  assert(count("pcb_trace") >= 8, "Carrier has too few routed connections")
  assert(count("source_component") >= 6, "Carrier lost its power/programming/status components")
  browserConnectivity = checkWifiCamera(state.circuitJson as CircuitJson)
  circuitSummary = { generation: state.generation, elementCounts: Object.fromEntries(
    [...new Set(state.circuitJson.map((element) => element.type))].sort()
      .map((type) => [type, count(type)])),
  }
}

try {
  const regulator = await native("import-C23380830", ["import", "C23380830"], 0)
  assert(regulator.includes("Imported C23380830"), "The bundled AP2112 regulator did not import locally")
  // These real camera modules remain outside the compact standalone catalog.
  for (const part of ["C277946", "C82899"]) {
    const output = await native(`import-${part}`, ["import", part], 1)
    assert(output.includes(part) && output.includes("not bundled") && output.includes("No network lookup"),
      `${part} did not report a useful local catalog miss`)
  }
  await native("carrier-build", ["build", entry, "--output-dir", join(artifacts, "native-build"), "--timeout-ms", "120000"], 0)
  nativeReport = JSON.parse(await readFile(join(artifacts, "native-build/wifi-camera-carrier.circuit.report.json"), "utf8"))
  nativeConnectivity = checkWifiCamera(JSON.parse(await readFile(join(artifacts, "native-build/wifi-camera-carrier.circuit.json"), "utf8")))
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
  assert((await page.goto(origin))?.ok(), "Carrier RunFrame page failed to load")
  let state = await waitForState(page, (next) => next.status !== "building", "the Wi-Fi camera carrier")
  assertCarrier(state)
  await writeFile(join(artifacts, "browser.circuit.json"), JSON.stringify(state.circuitJson, null, 2))
  for (const view of ["PCB", "Schematic", "3D"] as const) {
    await openView(page, view, "wifi-camera", state)
  }
  const bom = await openMoreView(page, "BOM")
  assert((await bom.innerText()).length > 30, "Carrier BOM is empty")
  await bom.screenshot({ path: join(artifacts, "wifi-camera-bom.png") })
  const errors = await openMoreView(page, "Errors")
  await errors.screenshot({ path: join(artifacts, "wifi-camera-errors.png") })
  const json = await openMoreView(page, "Circuit JSON")
  await json.locator("table").waitFor({ state: "visible" })
  await json.screenshot({ path: join(artifacts, "wifi-camera-json.png") })

  const original = await readFile(entry, "utf8")
  const missing = /C277946.*not bundled|not bundled.*C277946/i
  expectedAuthoredErrors.push(missing)
  state = await saveSource(page,
    'export default () => <board width="40mm" height="40mm"><chip name="U_MISSING" footprint="dip16" supplierPartNumbers={{jlcpcb:["C277946"]}}/></board>',
    state.generation)
  assert(state.status === "error" && state.errorOrigin === "worker" && missing.test(state.error ?? ""),
    `The real missing camera module did not fail locally: ${JSON.stringify(state)}`)
  const missingView = await openMoreView(page, "Errors")
  assert(missing.test(await missingView.innerText()), "Missing camera module is absent from RunFrame Errors")
  await page.screenshot({ path: join(artifacts, "wifi-camera-missing-part.png"), fullPage: true })
  state = await saveSource(page, original, state.generation)
  assertCarrier(state)
  await page.getByRole("button", { name: "Rebuild", exact: true }).click()
  state = await waitForState(page, (next) => next.generation > state.generation && next.status !== "building", "carrier rebuild")
  assertCarrier(state)
  const downloads = join(artifacts, "downloads")
  await mkdir(downloads, { recursive: true })
  const downloaded = JSON.parse(await downloadArtifact(page, /Download Circuit JSON/i, downloads)) as { type: string }[]
  assert(downloaded.filter((element) => element.type === "pcb_plated_hole").length >= 16, "Downloaded carrier lost socket holes")
  for (const name of [/Download PCB SVG/i, /Download schematic SVG/i]) {
    const svg = await downloadArtifact(page, name, downloads)
    assert(svg.includes("<svg") && !/(?:href|src)\s*=\s*["']https?:\/\//i.test(svg), "Carrier SVG requires a remote asset")
  }
  await Bun.sleep(1000)
  assertBrowserEvidence(evidence)
  console.log(`Wi-Fi camera carrier passed native build, six RunFrame views, local camera-part failure/recovery, rebuild and downloads: ${new Set(evidence.requests).size} local resources; zero native network attempts, external browser attempts, or CSP violations.`)
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
