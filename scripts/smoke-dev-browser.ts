import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { inflateSync } from "node:zlib"
import type { CircuitJson } from "circuit-json"
import { checkBundledModules, type BundledModuleCheckReport } from "./check-bundled-modules"

type CircuitElement = {
  type: string
  name?: string
  resistance?: number
  manufacturer_part_number?: string
  source_component_id?: string
  schematic_component_id?: string
  cad_component_id?: string
  footprinter_string?: string
  model_jscad?: unknown
}
type DevState = {
  status: "building" | "ready" | "error"
  generation: number
  sourceRevision: string
  fsMap?: Record<string, string>
  mainComponentPath?: string
  error?: string
}
type BrowserCircuitState = DevState & {
  circuitJson?: CircuitElement[]
  report?: { errors: CircuitElement[] }
  errorOrigin?: "source-graph" | "worker"
}

type BrowserEvidence = {
  requests: string[]
  forbiddenRequests: string[]
  cspViolations: string[]
  browserErrors: string[]
  consoleErrors: string[]
  expectedDiagnostics: string[]
  failedRequests: string[]
  workerUrls: string[]
  monitorErrors: string[]
}

const emptyEvidence = (): BrowserEvidence => ({
  requests: [], forbiddenRequests: [], cspViolations: [], browserErrors: [],
  consoleErrors: [], failedRequests: [], workerUrls: [], monitorErrors: [],
  expectedDiagnostics: [],
})

const expectedAuthoredErrors: RegExp[] = []
const recordConsoleError = (message: string, evidence: BrowserEvidence) => {
  // RunFrame logs caught circuit failures as well as showing them in Errors.
  // Keep those exact negative-fixture diagnostics distinct from app failures.
  if (expectedAuthoredErrors.some((pattern) => pattern.test(message))) evidence.expectedDiagnostics.push(message)
  else evidence.consoleErrors.push(message)
}

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}

const delay = (milliseconds: number) => Bun.sleep(milliseconds)
const countPads = (state: BrowserCircuitState) => state.circuitJson?.filter((element) => element.type === "pcb_smtpad").length ?? 0
const resistance = (state: BrowserCircuitState, name: string) =>
  state.circuitJson?.find((element) => element.type === "source_component" && element.name === name)?.resistance

/** Read browser screenshot pixels without installing a second image toolkit. */
function screenshotColors(png: Buffer): number {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const channels = png[25] === 6 ? 4 : png[25] === 2 ? 3 : 0
  assert(png[24] === 8 && channels > 0, "Browser screenshot has an unsupported PNG format")
  const chunks: Buffer[] = []
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const pixels = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  let previous = Buffer.alloc(stride)
  const colors = new Set<number>()
  const paeth = (left: number, above: number, upperLeft: number) => {
    const prediction = left + above - upperLeft
    const a = Math.abs(prediction - left), b = Math.abs(prediction - above), c = Math.abs(prediction - upperLeft)
    return a <= b && a <= c ? left : b <= c ? above : upperLeft
  }
  for (let y = 0; y < height; y++) {
    const filter = pixels[y * (stride + 1)]!
    const row = Buffer.from(pixels.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? row[index - channels]! : 0
      const above = previous[index]!
      const upperLeft = index >= channels ? previous[index - channels]! : 0
      const predictor = filter === 1 ? left : filter === 2 ? above : filter === 3
        ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, upperLeft) : 0
      row[index] = (row[index]! + predictor) & 255
    }
    // Inspect the middle of the viewer, excluding the view cube and menus.
    if (y > height * 0.3 && y < height * 0.8) {
      for (let x = Math.floor(width * 0.2); x < width * 0.8; x++) {
        const index = x * channels
        colors.add((row[index]! >> 3) << 10 | (row[index + 1]! >> 3) << 5 | (row[index + 2]! >> 3))
      }
    }
    previous = row
  }
  return colors.size
}

/**
 * CSP-denied worker requests never reach Playwright's request/console events.
 * Subscribe to each dedicated worker's Chromium security log, including replayed
 * startup errors. This observes the real scripts without rewriting their code.
 */
async function monitorWorkers(
  context: BrowserContext,
  page: Page,
  evidence: BrowserEvidence,
): Promise<CDPSession> {
  const connection = await context.newCDPSession(page)
  let nextId = 0
  const pending = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>()
  const commandKey = (sessions: string[], id: number) => `${sessions.join("/")}:${id}`

  const send = async (
    sessions: string[],
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const id = ++nextId
    const response = new Promise((resolveResult, reject) => {
      pending.set(commandKey(sessions, id), { resolve: resolveResult, reject })
    })
    let message = JSON.stringify({ id, method, params })
    for (let index = sessions.length - 1; index > 0; index--) {
      message = JSON.stringify({
        id: ++nextId,
        method: "Target.sendMessageToTarget",
        params: { sessionId: sessions[index], message },
      })
    }
    try {
      await connection.send("Target.sendMessageToTarget", { sessionId: sessions[0]!, message })
      return await response
    } catch (error) {
      pending.delete(commandKey(sessions, id))
      throw error
    }
  }

  const attach = async (
    parentSessions: string[],
    event: { sessionId: string; targetInfo: { type: string; url: string } },
  ) => {
    const sessions = [...parentSessions, event.sessionId]
    if (event.targetInfo.type === "worker") evidence.workerUrls.push(event.targetInfo.url)
    try {
      await send(sessions, "Log.enable")
      await send(sessions, "Network.enable")
      await send(sessions, "Target.setAutoAttach", {
        autoAttach: true, waitForDebuggerOnStart: false, flatten: false,
      })
    } catch (error) {
      evidence.monitorErrors.push(`Could not monitor ${event.targetInfo.type} ${event.targetInfo.url}: ${error}`)
    }
  }

  const receive = (sessions: string[], message: string) => {
    const event = JSON.parse(message) as {
      id?: number
      error?: { message: string }
      result?: unknown
      method?: string
      params?: Record<string, any>
    }
    if (event.id !== undefined) {
      const command = pending.get(commandKey(sessions, event.id))
      if (command) {
        pending.delete(commandKey(sessions, event.id))
        if (event.error) command.reject(new Error(event.error.message))
        else command.resolve(event.result)
      }
      return
    }
    const params = event.params ?? {}
    if (event.method === "Target.receivedMessageFromTarget") {
      receive([...sessions, params.sessionId], params.message)
    } else if (event.method === "Target.attachedToTarget") {
      void attach(sessions, params as Parameters<typeof attach>[1])
    } else if (event.method === "Target.detachedFromTarget") {
      const prefix = `${[...sessions, params.sessionId].join("/")}:`
      for (const [key, command] of pending) {
        if (key.startsWith(prefix)) {
          pending.delete(key)
          command.reject(new Error("Worker disconnected before its offline monitor was initialized"))
        }
      }
    } else if (event.method === "Log.entryAdded") {
      const entry = params.entry
      if (/content security policy|violates.*directive|refused to connect/i.test(entry.text)) {
        evidence.cspViolations.push(`Worker ${entry.url}: ${entry.text}`)
      } else if (entry.level === "error") {
        recordConsoleError(`Worker ${entry.url}: ${entry.text}`, evidence)
      }
    } else if (event.method === "Network.requestWillBeSent") {
      observeRequest(params.request.url, page.url(), evidence)
    } else if (event.method === "Network.loadingFailed" && params.blockedReason === "csp") {
      evidence.cspViolations.push(`Worker request ${params.requestId} was blocked by CSP`)
    }
  }

  connection.on("Target.receivedMessageFromTarget", (event) => receive([event.sessionId], event.message))
  connection.on("Target.attachedToTarget", (event) => { void attach([], event) })
  await connection.send("Target.setAutoAttach", {
    autoAttach: true, waitForDebuggerOnStart: false, flatten: false,
  })
  return connection
}

async function selfCheckWorkerMonitor(browser: Browser) {
  const cspSentinel = "https://example.invalid/worker-csp-proof"
  const policy = "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'"
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      const worker = pathname === "/worker.js"
      const content = worker
        ? 'fetch("/local").then(() => fetch("https://example.invalid/worker-csp-proof")).catch(() => {}).finally(() => postMessage("complete"))'
        : pathname === "/local" ? "ok" : "<!doctype html><body>Worker monitor fixture</body>"
      return new Response(content, { headers: {
        "content-type": worker ? "text/javascript" : pathname === "/local" ? "text/plain" : "text/html",
        "content-security-policy": policy,
      } })
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  const evidence = emptyEvidence()
  const context = await browser.newContext({ serviceWorkers: "block" })
  try {
    context.on("request", (request) => observeRequest(request.url(), origin, evidence))
    await context.route("**/*", (route) => new URL(route.request().url()).origin === origin
      ? route.continue() : route.abort("blockedbyclient"))
    const page = await context.newPage()
    await monitorWorkers(context, page, evidence)
    await page.goto(origin)
    await page.evaluate(() => {
      const worker = new Worker("/worker.js")
      worker.onmessage = () => { document.body.dataset.workerComplete = "yes" }
    })
    await page.waitForFunction(() => document.body.dataset.workerComplete === "yes")
    const deadline = Date.now() + 3000
    while (!evidence.cspViolations.length && Date.now() < deadline) await delay(50)
    assert(evidence.cspViolations.some((message) => message.includes("example.invalid/worker-csp-proof")),
      "The browser monitor missed a CSP-denied dedicated-worker request")
    assert(evidence.requests.includes(`${origin}/local`), "The browser monitor missed the valid worker request")
    assert(evidence.forbiddenRequests.every((url) => url === cspSentinel) && evidence.monitorErrors.length === 0,
      "The worker monitor fixture observed an unexpected external request or could not attach its monitor")
    console.log("Qualified dedicated-worker request/CSP monitoring with a separate local fixture.")
  } finally {
    await context.close()
    server.stop(true)
  }
}

function observeRequest(url: string, origin: string, evidence: BrowserEvidence) {
  evidence.requests.push(url)
  const parsed = new URL(url)
  const app = new URL(origin)
  const sameOriginSocket = parsed.host === app.host &&
    ((parsed.protocol === "ws:" && app.protocol === "http:") ||
      (parsed.protocol === "wss:" && app.protocol === "https:"))
  if (!["data:", "blob:"].includes(parsed.protocol) && parsed.origin !== app.origin && !sameOriginSocket) {
    evidence.forbiddenRequests.push(url)
  }
}

function assertBrowserEvidence(evidence: BrowserEvidence) {
  const problems = {
    forbiddenRequests: [...new Set(evidence.forbiddenRequests)],
    cspViolations: [...new Set(evidence.cspViolations)],
    browserErrors: [...new Set(evidence.browserErrors)],
    consoleErrors: [...new Set(evidence.consoleErrors)],
    failedRequests: [...new Set(evidence.failedRequests)],
    monitorErrors: [...new Set(evidence.monitorErrors)],
  }
  assert(Object.values(problems).every((entries) => entries.length === 0),
    `Offline browser checks failed:\n${JSON.stringify(problems, null, 2)}`)
}

async function waitForState(
  page: Page,
  accepts: (state: BrowserCircuitState) => boolean,
  description: string,
): Promise<BrowserCircuitState> {
  const deadline = Date.now() + 60_000
  let latest: BrowserCircuitState | undefined
  while (Date.now() < deadline) {
    latest = await page.evaluate(async () => {
      const response = await fetch("/api/state")
      if (!response.ok) throw new Error(`State API returned ${response.status}`)
      const graph = await response.json() as DevState
      if ("circuitJson" in graph || "report" in graph) {
        throw new Error("The dev server rendered circuit output instead of delivering source to RunFrame")
      }
      if (graph.status === "error") return { ...graph, errorOrigin: "source-graph" as const }
      if (graph.status !== "ready") return graph
      if (!graph.fsMap || !graph.mainComponentPath || !(graph.mainComponentPath in graph.fsMap)) {
        throw new Error("The ready dev state did not include the browser worker's source graph")
      }
      const status = document.querySelector('[data-testid="build-status"]')
      if (status?.getAttribute("data-generation") !== String(graph.generation)) {
        return { ...graph, status: "building" as const }
      }
      const message = status.textContent ?? ""
      if (message.includes("Build failed")) {
        return { ...graph, status: "error" as const,
          errorOrigin: "worker" as const,
          error: document.querySelector('[data-testid="build-error"]')?.textContent ?? "Browser render failed" }
      }
      if (!message.startsWith("Built")) return { ...graph, status: "building" as const }
      if (graph.mainComponentPath.endsWith(".circuit.json")) {
        // Static JSON uses RunFrame's ordinary static viewer. Downloads below
        // check its displayed data; it does not need an evaluated circuit.
        const circuitJson = JSON.parse(graph.fsMap[graph.mainComponentPath]!) as CircuitElement[]
        return { ...graph, circuitJson,
          report: { errors: circuitJson.filter((element) => element.type.endsWith("_error")) } }
      }
      const worker = (window as unknown as {
        runFrameWorker?: { getCircuitJson: () => Promise<CircuitElement[]> }
      }).runFrameWorker
      if (!worker) return { ...graph, status: "building" as const }
      const circuitJson = await worker.getCircuitJson()
      return { ...graph, circuitJson,
        report: { errors: circuitJson.filter((element) => element.type.endsWith("_error")) } }
    }) as BrowserCircuitState
    if (accepts(latest)) return latest
    await delay(150)
  }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(latest)}`)
}

async function saveSource(page: Page, source: string, afterGeneration: number) {
  await page.getByLabel("Circuit source", { exact: true }).fill(source)
  const saved = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/source" && response.request().method() === "POST")
  await page.getByRole("button", { name: "Save and rebuild", exact: true }).click()
  const response = await saved
  assert(response.ok(), `Saving source failed with HTTP ${response.status()}: ${await response.text()}`)
  const { revision } = await response.json() as { revision: string }
  return waitForState(page,
    (state) => state.generation > afterGeneration && state.sourceRevision === revision && state.status !== "building",
    "the edited circuit in RunFrame's browser worker")
}

async function openMoreView(page: Page, name: "BOM" | "Errors" | "Circuit JSON") {
  await page.getByRole("button", { name: "More views", exact: true }).click()
  await page.getByRole("menuitem", { name: new RegExp(`^${name}( *[0-9]+)?$`, "i") }).click()
  const panel = page.locator('[role="tabpanel"][data-state="active"]')
  await panel.waitFor({ state: "visible" })
  return panel
}

async function openView(page: Page, name: "PCB" | "Schematic" | "3D", fixture: string, state: BrowserCircuitState, requiresStyleArtifacts = false) {
  await page.getByRole("tab", { name, exact: true }).click()
  const panel = page.locator('[role="tabpanel"][data-state="active"]')
  await panel.waitFor({ state: "visible" })
  if (name === "Schematic") {
    await panel.locator("[data-schematic-component-id]").first().waitFor({ state: "visible" })
    const chip = state.circuitJson?.find((element) => element.type === "source_component" && element.name === "U1")
    const schematicChip = chip && state.circuitJson?.find((element) =>
      element.type === "schematic_component" && element.source_component_id === chip.source_component_id)
    const component = schematicChip?.schematic_component_id
      ? panel.locator(`[data-schematic-component-id=${JSON.stringify(schematicChip.schematic_component_id)}]`).first()
      : panel.locator("[data-schematic-component-id]").first()
    await component.waitFor({ state: "visible" })
    // The viewer deliberately routes pointer events through a transparent layer.
    await component.hover({ force: true })
    await delay(700)
    await component.click({ force: true })
    await delay(300)
    if (chip) {
      const details = page.getByRole("dialog", { name: "U1 component details", exact: true })
      await details.waitFor({ state: "visible" })
      assert((await details.innerText()).includes("C2040"), "RP2040 supplier ID did not appear in its component tooltip")
      assert(await details.locator('a[href^="https://jlcpcb.com/"]').count() > 0, "Component details lost their JLCPCB supplier hyperlink")
      await details.getByRole("status", { name: /price and stock/i }).waitFor({ state: "visible" })
      const thumbnail = details.getByRole("img", { name: /PCB footprint/ })
      await thumbnail.waitFor({ state: "visible" })
      assert((await thumbnail.getAttribute("src"))?.startsWith("data:image/svg+xml"), "Component footprint thumbnail did not use the bundled renderer")
    }
    await page.keyboard.press("Escape")
    // Component context menus contain navigation; analysis lives on the background.
    await panel.click({ position: { x: 70, y: 90 }, button: "right", force: true })
    const analysis = page.getByRole("menuitem", { name: "Run Style Analysis", exact: true })
    await analysis.waitFor({ state: "visible" })
    assert(await analysis.getAttribute("aria-disabled") !== "true", "The bundled style analyzer was disabled")
    await analysis.click()
    const dialog = page.getByRole("dialog", { name: "Style Analysis", exact: true })
    await dialog.waitFor({ state: "visible" })
    await dialog.getByRole("status").filter({ hasText: /No style issues found|[0-9]+ style issues? found/ }).waitFor({ state: "visible" })
    const artifacts = dialog.locator("img")
    if (requiresStyleArtifacts) assert(await artifacts.count() > 0, "The overlapping schematic did not produce style-analysis issue SVGs")
    for (const image of await artifacts.all()) {
      const source = await image.getAttribute("src")
      assert(source?.startsWith("data:image/svg+xml") && decodeURIComponent(source.split(",")[1] ?? "").includes("<svg"),
        "Style analysis did not render a bundled SVG artifact")
    }
    await dialog.getByRole("button", { name: "Close", exact: true }).click()
  } else if (name === "PCB") {
    await panel.locator("canvas, [data-pcb-component-id], [data-pcb-smtpad-id]").first().waitFor({ state: "visible" })
    assert(!/rendering failed|error loading.*viewer|no webgpu adapter/i.test(await panel.innerText()), "The PCB renderer displayed a failure instead of the circuit")
  } else {
    await panel.locator("canvas").first().waitFor({ state: "visible" })
    const modelIds = state.circuitJson?.filter((element) =>
      element.type === "cad_component" && (element.footprinter_string || element.model_jscad))
      .map((element) => element.cad_component_id).filter((id): id is string => !!id) ?? []
    assert(modelIds.length > 0, "The fixture contains no procedural component models to qualify")
    // The default Manifold viewer does not forward its scene ref. Qualify its
    // actual pixels and CAD metadata, and retain screenshots for model review.
    await delay(1500)
    assert(!/rendering failed|error loading|failed to initialize/i.test(await panel.innerText()), "The 3D renderer displayed a failure")
    assert(screenshotColors(await panel.screenshot()) > 30, "The 3D viewer did not draw a populated board/model region")
  }
  if (process.env.SMOKE_ARTIFACT_DIR) {
    const directory = resolve(process.env.SMOKE_ARTIFACT_DIR)
    await mkdir(directory, { recursive: true })
    await panel.screenshot({ path: join(directory, `${fixture}-${name.toLowerCase()}.png`) })
  }
}

async function downloadArtifact(page: Page, name: RegExp, directory: string) {
  const control = page.getByRole("button", { name }).or(page.getByRole("link", { name }))
  const downloaded = page.waitForEvent("download")
  await control.click()
  const download = await downloaded
  const output = join(directory, download.suggestedFilename())
  await download.saveAs(output)
  assert(!await download.failure(), `Download failed: ${download.suggestedFilename()}`)
  return await readFile(output, "utf8")
}

async function createMonitoredPage(
  browser: Browser,
  origin: string,
  evidence: BrowserEvidence,
  isExpectedImportConflict: () => boolean = () => false,
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", acceptDownloads: true,
  })
  context.on("request", (request) => observeRequest(request.url(), origin, evidence))
  context.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED") {
      evidence.failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`)
    }
  })
  context.on("response", (response) => {
    if (isExpectedImportConflict() && response.status() === 409 &&
      new URL(response.url()).pathname === "/api/import") return
    if (response.status() >= 400) evidence.failedRequests.push(`${response.status()} ${response.url()}`)
  })
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === origin || ["blob:", "data:"].includes(url.protocol)) await route.continue()
    else {
      evidence.forbiddenRequests.push(url.href)
      await route.abort("blockedbyclient")
    }
  })
  await context.exposeBinding("__standaloneCspViolation", (_source, details: string) => {
    evidence.cspViolations.push(details)
  })
  await context.addInitScript(() => {
    window.addEventListener("securitypolicyviolation", (event) => {
      const report = (window as unknown as { __standaloneCspViolation: (message: string) => void }).__standaloneCspViolation
      report(`${event.violatedDirective}: ${event.blockedURI}`)
    })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  page.on("pageerror", (error) => evidence.browserErrors.push(error.message))
  page.on("console", (message) => {
    if (isExpectedImportConflict() && /status of 409/.test(message.text()) &&
      new URL(message.location().url).pathname === "/api/import") return
    if (message.type() === "error") recordConsoleError(message.text(), evidence)
  })
  page.on("worker", (worker) => evidence.workerUrls.push(worker.url()))
  page.on("websocket", (socket) => observeRequest(socket.url(), origin, evidence))
  await monitorWorkers(context, page, evidence)
  return page
}

async function qualifyStaticCircuit(
  binary: string,
  projectDir: string,
  browser: Browser,
  circuitJson: CircuitElement[],
  evidence: BrowserEvidence,
) {
  const entry = join(projectDir, "cached.circuit.json")
  const cached = circuitJson.map((element) => element.type === "source_component"
    ? { ...element, manufacturer_part_number: "SAVED-UNKNOWN-MPN", supplier_part_numbers: { cachedSupplier: ["SAVED-UNKNOWN-PART"] } }
    : element)
  await writeFile(entry, JSON.stringify(cached))
  const devProcess = Bun.spawn([binary, "dev", entry, "--port", "0", "--project-dir", projectDir], {
    cwd: projectDir,
    env: { PATH: projectDir, BUN_INSTALL_AUTO: "disable", HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  let output = ""
  let resolveUrl: ((url: string) => void) | undefined
  let rejectStartup: ((error: Error) => void) | undefined
  const startup = new Promise<string>((resolve, reject) => { resolveUrl = resolve; rejectStartup = reject })
  const outputReaders = [devProcess.stdout, devProcess.stderr].map(async (stream) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      output += decoder.decode(value, { stream: true })
      const match = output.match(/RunFrame:\s*(http:\/\/127\.0\.0\.1:\d+)\/?/)
      if (match) resolveUrl?.(match[1]!)
    }
  })
  const startupTimer = setTimeout(() => rejectStartup?.(new Error(`Static dev startup timed out:\n${output}`)), 60_000)
  void devProcess.exited.then((code) => rejectStartup?.(new Error(`Static dev exited ${code}:\n${output}`)))
  let page: Page | undefined
  try {
    const origin = await startup
    clearTimeout(startupTimer)
    page = await createMonitoredPage(browser, origin, evidence)
    const response = await page.goto(origin)
    assert(response?.ok(), "The static Circuit JSON page did not load")
    let state = await waitForState(page, (next) => next.status === "ready", "cached Circuit JSON geometry")
    assert(state.mainComponentPath?.endsWith(".circuit.json"), "Static mode lost its Circuit JSON entry suffix")
    assert(countPads(state) === 72, "Cached Circuit JSON lost RP2040 pads")
    await openView(page, "PCB", "cached-json", state)
    await page.getByRole("button", { name: "Rebuild", exact: true }).click()
    state = await waitForState(page, (next) => next.generation > state.generation && next.status === "ready", "a static Circuit JSON rebuild")
    const updated = JSON.stringify(cached).replaceAll("SAVED-UNKNOWN-MPN", "SAVED-EDITED-MPN")
    state = await saveSource(page, updated, state.generation)
    assert(state.status === "ready", "Saving cached metadata failed in RunFrame static mode")
    const downloadDir = join(projectDir, "static-downloads")
    await mkdir(downloadDir)
    const downloaded = JSON.parse(await downloadArtifact(page, /Download Circuit JSON/i, downloadDir)) as CircuitElement[]
    assert(downloaded.filter((element) => element.type === "pcb_smtpad").length === 72, "Static download lost its geometry")
    assert(downloaded.some((element) => element.type === "source_component" && element.manufacturer_part_number === "SAVED-EDITED-MPN"),
      "Static download did not preserve edited unknown part metadata")
    assert(JSON.stringify(downloaded).includes('"cachedSupplier":["SAVED-UNKNOWN-PART"]'),
      "Static download did not preserve cached supplier metadata")
    const remoteBuffer = "https://example.invalid/embedded-buffer.bin"
    const embeddedGltf = `data:model/gltf+json;base64,${Buffer.from(JSON.stringify({
      asset: { version: "2.0" }, buffers: [{ uri: remoteBuffer, byteLength: 4 }],
    })).toString("base64")}`
    const invalidAssetSource = JSON.stringify([...downloaded, {
      type: "cad_component", cad_component_id: "cached_remote_gltf", model_gltf_url: embeddedGltf,
    }])
    state = await saveSource(page, invalidAssetSource, state.generation)
    assert(state.status === "error" && state.error?.includes(remoteBuffer),
      "An embedded GLTF with a remote buffer did not report a local graph error")
    assert(state.errorOrigin === "source-graph", "The cached remote asset was not rejected by the source graph")
    assert(!state.fsMap && !state.mainComponentPath && !state.circuitJson,
      "The rejected embedded GLTF graph reached the viewer")
    await page.getByTestId("build-error").waitFor({ state: "visible" })
    await page.waitForFunction((remoteBuffer) =>
      document.querySelector('[data-testid="build-error"]')?.textContent?.includes(remoteBuffer), remoteBuffer)
    await page.locator(".runframe.graph-error").waitFor({ state: "visible" })
    assert(await page.getByRole("button", { name: "Download Circuit JSON", exact: true }).isDisabled(),
      "A rejected cached asset left stale JSON available to download")
    state = await saveSource(page, updated, state.generation)
    assert(state.status === "ready" && countPads(state) === 72,
      "The static viewer did not recover after rejecting the embedded remote buffer")
    const recoveredDownload = JSON.parse(await downloadArtifact(page, /Download Circuit JSON/i, downloadDir)) as CircuitElement[]
    assert(recoveredDownload.filter((element) => element.type === "pcb_smtpad").length === 72 &&
      !JSON.stringify(recoveredDownload).includes(embeddedGltf),
      "The recovered static download did not contain the valid cached geometry")
    if (process.env.SMOKE_ARTIFACT_DIR) {
      const directory = resolve(process.env.SMOKE_ARTIFACT_DIR)
      await writeFile(join(directory, "static-dev-output.txt"), output)
      await Promise.all(["static-browser-failure.png", "static-browser-failure.html"].map((file) => rm(join(directory, file), { force: true })))
    }
    console.log("Qualified normal RunFrame static Circuit JSON geometry, rebuilding, editing, cached metadata downloads, and embedded remote GLTF rejection/recovery.")
  } catch (error) {
    if (process.env.SMOKE_ARTIFACT_DIR) {
      const directory = resolve(process.env.SMOKE_ARTIFACT_DIR)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, "static-dev-output.txt"), output)
      await page?.screenshot({ path: join(directory, "static-browser-failure.png"), fullPage: true }).catch(() => {})
      if (page) await writeFile(join(directory, "static-browser-failure.html"), await page.content()).catch(() => {})
    }
    throw error
  } finally {
    clearTimeout(startupTimer)
    await page?.context().close()
    devProcess.kill()
    await Promise.race([devProcess.exited, delay(2000)])
    if (devProcess.exitCode === null) devProcess.kill("SIGKILL")
    await devProcess.exited
    await Promise.all(outputReaders)
  }
}

async function main() {
  const binary = resolve(process.env.STANDALONE_BINARY ?? (process.platform === "win32" ? "dist/tsci.exe" : "dist/tsci"))
  const projectDir = await mkdtemp(join(tmpdir(), "standalone-runframe-"))
  let browser: Browser | undefined
  let page: Page | undefined
  const evidence = emptyEvidence()
  let bundledModuleReport: BundledModuleCheckReport | undefined
  let expectedImportConflict = false
  await cp(resolve(import.meta.dir, "../examples"), join(projectDir, "examples"), { recursive: true })
  const entry = join(projectDir, "examples/led-resistor.circuit.tsx")
  const devProcess = Bun.spawn([
    binary, "dev", entry, "--port", "0", "--project-dir", projectDir,
  ], {
    cwd: projectDir,
    env: {
      PATH: projectDir, BUN_INSTALL_AUTO: "disable",
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  let output = ""
  let ready: ((url: string) => void) | undefined
  let startupError: ((error: Error) => void) | undefined
  const startup = new Promise<string>((resolveUrl, reject) => { ready = resolveUrl; startupError = reject })
  const readOutput = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      output += decoder.decode(value, { stream: true })
      const match = output.match(/RunFrame:\s*(http:\/\/127\.0\.0\.1:\d+)\/?/)
      if (match) ready?.(match[1]!)
    }
  }
  const outputReaders = [readOutput(devProcess.stdout), readOutput(devProcess.stderr)]
  const startupTimer = setTimeout(() => startupError?.(new Error(`Dev startup timed out:\n${output}`)), 60_000)
  void devProcess.exited.then((code) => startupError?.(new Error(`Dev exited ${code}:\n${output}`)))

  try {
    const origin = await startup
    clearTimeout(startupTimer)
    browser = await chromium.launch({
      ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
      headless: true,
      args: [
        "--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking",
        "--disable-component-update", "--disable-sync", "--no-first-run",
        "--no-default-browser-check", "--proxy-server=direct://",
        "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
      ],
    })
    await selfCheckWorkerMonitor(browser)
    page = await createMonitoredPage(browser, origin, evidence, () => expectedImportConflict)
    const response = await page.goto(origin)
    assert(response && response.ok(), "The embedded RunFrame page did not load")
    assert(response.headers()["content-security-policy"]?.includes("connect-src"), "The local page did not enforce a connection CSP")
    const hostSettings = await page.evaluate(() => ({
      telemetryDisabled: Reflect.get(window, "TSCIRCUIT_TELEMETRY_DISABLED"),
      allowSelectingEvalVersion: Reflect.get(window, "TSCIRCUIT_ALLOW_SELECTING_EVAL_VERSION"),
      pcbRenderer: JSON.parse(localStorage.getItem("pcb_viewer_rendering_engine") ?? "null"),
    }))
    assert(hostSettings.telemetryDisabled === true && hostSettings.allowSelectingEvalVersion === false && hostSettings.pcbRenderer === "canvas",
      "The embedded startup script did not apply RunFrame host settings and the PCB viewer's existing preference")
    let state = await waitForState(page, (next) => next.status === "ready", "initial LED rendering")
    assert(evidence.workerUrls.some((url) => new URL(url).pathname === "/assets/eval-worker.js"),
      "RunFrame did not execute the circuit in the bundled browser eval worker")
    assert(countPads(state) === 6, "Initial circuit did not contain six LED/resistor/testpoint pads")
    assert(state.report?.errors.length === 0, "Initial LED circuit reported errors")
    assert(state.circuitJson, "The initial browser render did not publish circuit JSON")
    bundledModuleReport = await checkBundledModules(page, state.circuitJson as CircuitJson)
    console.log(`Qualified ${Object.keys(bundledModuleReport.namespaces).length} bundled module namespaces and ${Object.keys(bundledModuleReport.operations).length} module operations under request and CSP monitoring.`)
    await page.getByTestId("build-status").waitFor({ state: "visible" })
    await openView(page, "PCB", "led", state)
    await openView(page, "Schematic", "led", state)
    await openView(page, "3D", "led", state)
    console.log("Qualified LED PCB, schematic interactions, and procedural 3D.")

    const originalSource = await readFile(entry, "utf8")
    const editedResistorName = "R_UI_Ω_中文_😀"
    const editedSource = originalSource.replace("<StatusLed />",
      `<StatusLed /><resistor name="${editedResistorName}" resistance="4.7k" footprint="0603" pcbX={0} pcbY={-4} schX={0} schY={-3} />`)
    state = await saveSource(page, editedSource, state.generation)
    assert(state.status === "ready" && resistance(state, editedResistorName) === 4700, "Saving through the editor did not rebuild the changed circuit")
    assert((await readFile(entry, "utf8")).includes(editedResistorName), "The editor did not persist the circuit source")
    await openView(page, "3D", "unicode-label", state)
    const generationBeforeWatch = state.generation
    const helper = join(projectDir, "examples/helpers/status-led.tsx")
    await writeFile(helper, (await readFile(helper, "utf8")).replace('resistance="1k"', 'resistance="2.2k"'))
    state = await waitForState(page,
      (next) => next.generation > generationBeforeWatch && next.status === "ready" && resistance(next, "R1") === 2200,
      "a watched helper-file rebuild")
    const generationBeforeEntryWatch = state.generation
    await writeFile(entry, `${editedSource}\n// Updated outside the editor.\n`)
    state = await waitForState(page,
      (next) => next.generation > generationBeforeEntryWatch && next.status === "ready",
      "a watched entry-file rebuild")
    const sourceEditor = page.getByLabel("Circuit source", { exact: true })
    const sourceDeadline = Date.now() + 10_000
    while (!(await sourceEditor.inputValue()).includes("Updated outside the editor.") && Date.now() < sourceDeadline) {
      await delay(150)
    }
    assert((await sourceEditor.inputValue()).includes("Updated outside the editor."), "The editor did not refresh externally changed source")
    await page.getByRole("button", { name: "Rebuild", exact: true }).click()
    state = await waitForState(page,
      (next) => next.generation > state.generation && next.status === "ready", "an explicit rebuild")
    console.log("Qualified source editing, Unicode CAD labels, file watching, and explicit rebuilding.")

    await page.getByRole("button", { name: "Bundled parts", exact: true }).click()
    await page.getByLabel("Search bundled parts", { exact: true }).fill("RP2040")
    await page.getByRole("button", { name: "Import C2040", exact: true }).click()
    await page.getByRole("status").filter({ hasText: /Imported RP2040 to/ }).waitFor({ state: "visible" })
    const imported = await readFile(join(projectDir, "imports/C2040.tsx"), "utf8")
    assert(imported.includes("RP2040") && imported.includes("qfn56_"), "Catalog UI import did not generate the embedded RP2040")
    expectedImportConflict = true
    const conflict = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/import" && response.status() === 409)
    await page.getByRole("button", { name: "Import C2040", exact: true }).click()
    await conflict
    await page.waitForFunction(() => document.querySelector('[data-testid="build-error"]')?.textContent?.includes("already exists and was preserved"))
    assert(await readFile(join(projectDir, "imports/C2040.tsx"), "utf8") === imported, "Repeated UI import overwrote the existing component")
    await delay(100)
    expectedImportConflict = false
    await page.getByRole("button", { name: "Bundled parts", exact: true }).click()
    const rp2040Source = (await readFile(join(projectDir, "examples/rp2040-breakout.circuit.tsx"), "utf8"))
      .replace('"./imports/C2040"', '"../imports/C2040"')
    state = await saveSource(page, rp2040Source, state.generation)
    assert(state.status === "ready" && countPads(state) === 72, "The UI-imported RP2040 did not preserve all circuit pads")
    assert(state.circuitJson?.some((element) => element.name === "U1" && element.manufacturer_part_number === "RP2040"), "RP2040 identity was lost")
    await openView(page, "Schematic", "rp2040", state)
    await openView(page, "PCB", "rp2040", state)
    await openView(page, "3D", "rp2040", state)
    const bom = await openMoreView(page, "BOM")
    await bom.getByText("C2040", { exact: true }).first().waitFor({ state: "visible" })
    assert(await bom.locator('a[href^="https://jlcpcb.com/"]').count() > 0, "The BOM lost its supplier hyperlinks")
    const errors = await openMoreView(page, "Errors")
    assert(/warning|no.*errors/i.test(await errors.innerText()), "The Errors view did not display circuit diagnostics")
    const json = await openMoreView(page, "Circuit JSON")
    await json.locator("table").waitFor({ state: "visible" })
    console.log("Qualified catalog import/conflict preservation and RP2040 PCB, schematic, 3D, BOM, Errors, and JSON views.")

    const styleSource = `export default () => <board width="20mm" height="12mm"><resistor name="R_STYLE_A" resistance="1k" footprint="0603" pcbX={-3} schX={0} schY={0}/><resistor name="R_STYLE_B" resistance="2k" footprint="0603" pcbX={3} schX={0.1} schY={0}/></board>`
    state = await saveSource(page, styleSource, state.generation)
    assert(state.status === "ready" && countPads(state) === 4, "The style-analysis fixture did not render in the browser worker")
    await openView(page, "Schematic", "style-overlap", state, true)
    console.log("Qualified enabled style analysis with bundled issue SVGs and preserved supplier links.")

    const rejectedSources = [
      ["unknown part", 'export default () => <board width="10mm" height="10mm"><chip name="U1" footprint="qfn8" supplierPartNumbers={{jlcpcb:["C999999999"]}}/></board>', /C999999999.*not bundled|not bundled.*C999999999/i, "worker"],
      ["unknown module", 'import Missing from "unbundled-example-package"; export default Missing', /unbundled-example-package.*not bundled|not bundled.*unbundled-example-package/i, "source-graph"],
      ["remote footprint", 'export default () => <board width="10mm" height="10mm"><chip name="U1" footprint="https://example.invalid/footprint.json"/></board>', /example\.invalid\/footprint\.json|footprint.*(?:not bundled|not supported|unavailable)/i, "worker"],
    ] as const
    for (const [name, source, expected, errorOrigin] of rejectedSources) {
      expectedAuthoredErrors.push(expected)
      state = await saveSource(page, source, state.generation)
      assert(state.status === "error" && expected.test(state.error ?? ""), `${name} did not fail with a useful local error: ${JSON.stringify(state)}`)
      assert(state.errorOrigin === errorOrigin, `${name} failed at the wrong boundary: ${state.errorOrigin}`)
      await page.getByTestId("build-error").waitFor({ state: "visible" })
      await page.waitForFunction(([pattern, flags]) =>
        new RegExp(pattern, flags).test(document.querySelector('[data-testid="build-error"]')?.textContent ?? ""),
      [expected.source, expected.flags])
      if (errorOrigin === "source-graph") {
        // The host never supplied rejected source to the evaluator. Its editor
        // reports this error while RunFrame remains mounted with a hidden preview.
        assert(!state.fsMap && !state.mainComponentPath, "A rejected source graph reached RunFrame")
        await page.locator(".runframe.graph-error").waitFor({ state: "visible" })
      } else {
        const diagnostics = await openMoreView(page, "Errors")
        assert(expected.test(await diagnostics.innerText()), `${name} error was not visible in the RunFrame Errors view`)
      }
    }
    state = await saveSource(page, rp2040Source, state.generation)
    assert(state.status === "ready", "The editor did not recover after rejected offline content")
    const downloadDir = join(projectDir, "downloads")
    await mkdir(downloadDir)
    const downloadedJson = JSON.parse(await downloadArtifact(page, /Download Circuit JSON/i, downloadDir)) as CircuitElement[]
    assert(downloadedJson.filter((element) => element.type === "pcb_smtpad").length === 72, "Circuit JSON export did not contain the current build")
    for (const name of [/Download PCB SVG/i, /Download schematic SVG/i]) {
      const svg = await downloadArtifact(page, name, downloadDir)
      assert(svg.includes("<svg") && !/(?:href|src)\s*=\s*["']https?:\/\//i.test(svg), "SVG export contains an unavailable external asset")
    }
    const files = await readdir(projectDir)
    assert(!files.includes("node_modules"), "The compiled dev command installed project dependencies")
    assert(evidence.requests.some((url) => url.includes("/api/state")), "Browser did not exercise the same-origin build API")
    assert(state.circuitJson, "The recovered RP2040 render did not publish circuit JSON")
    await qualifyStaticCircuit(binary, projectDir, browser, state.circuitJson, evidence)
    // Allow delayed tooltip/font activity to surface before judging the run.
    await delay(1000)
    assertBrowserEvidence(evidence)
    if (process.env.SMOKE_ARTIFACT_DIR) {
      const directory = resolve(process.env.SMOKE_ARTIFACT_DIR)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, "browser-evidence.json"), JSON.stringify(evidence, null, 2))
      await writeFile(join(directory, "bundled-modules-evidence.json"), JSON.stringify(bundledModuleReport, null, 2))
      await writeFile(join(directory, "dev-output.txt"), output)
      await Promise.all(["browser-failure.png", "browser-failure.html"].map((file) => rm(join(directory, file), { force: true })))
    }
    console.log(`Compiled offline RunFrame passed: LED and RP2040 PCB/schematic/3D, editor/rebuild/watch, catalog import, local failure recovery, static cached JSON, bundled conversions and JSON/SVG downloads; ${new Set(evidence.requests).size} same-origin resources, ${new Set(evidence.workerUrls).size} observed browser worker URLs, zero external request attempts or CSP violations.`)
  } catch (error) {
    const panel = page?.locator('[role="tabpanel"][data-state="active"]')
    const diagnostics = {
      browserVersion: browser?.version(),
      activePanelText: await panel?.innerText({ timeout: 1000 }).then((text) => text.slice(0, 2000)).catch(() => undefined),
      canvases: await panel?.locator("canvas").evaluateAll((canvases) => canvases.map((canvas) => {
        const bounds = canvas.getBoundingClientRect()
        return { width: bounds.width, height: bounds.height }
      })).catch(() => undefined),
      ...Object.fromEntries(Object.entries(evidence).filter(([name]) => name !== "requests" && name !== "workerUrls")),
    }
    console.error(`Offline browser qualification failed: ${JSON.stringify(diagnostics)}`)
    if (process.env.SMOKE_ARTIFACT_DIR) {
      const directory = resolve(process.env.SMOKE_ARTIFACT_DIR)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, "browser-evidence.json"), JSON.stringify(evidence, null, 2))
      if (bundledModuleReport) await writeFile(join(directory, "bundled-modules-evidence.json"), JSON.stringify(bundledModuleReport, null, 2))
      await writeFile(join(directory, "dev-output.txt"), output)
      await page?.screenshot({ path: join(directory, "browser-failure.png"), fullPage: true }).catch(() => {})
      if (page) await writeFile(join(directory, "browser-failure.html"), await page.content()).catch(() => {})
    }
    throw error
  } finally {
    clearTimeout(startupTimer)
    await browser?.close()
    devProcess.kill()
    await Promise.race([devProcess.exited, delay(2000)])
    if (devProcess.exitCode === null) devProcess.kill("SIGKILL")
    await devProcess.exited
    await Promise.all(outputReaders)
    await rm(projectDir, { recursive: true, force: true })
  }
}

export {
  assertBrowserEvidence, createMonitoredPage, downloadArtifact, emptyEvidence,
  expectedAuthoredErrors, openMoreView, openView, saveSource,
  selfCheckWorkerMonitor, waitForState,
}
export type { BrowserCircuitState }

if (import.meta.main) await main()
