import { createHash, randomUUID } from "node:crypto"
import { watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { inspectCircuitJson, renderCircuitFile, waitForCircuitWorkerTeardown } from "./build"
import { bundledCatalog, generateBundledComponentTsx, getBundledPart } from "./catalog"
import type {
  StandaloneDevImport,
  StandaloneDevOptions,
  StandaloneDevSource,
  StandaloneDevState,
} from "./dev-types"
import { readCircuitProject } from "./read-circuit-project"

const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_REQUEST_BYTES = MAX_SOURCE_BYTES + 64 * 1024
const SOURCE_EXTENSIONS = new Set([
  ".tsx", ".ts", ".jsx", ".js", ".json", ".mts", ".cts", ".mjs", ".cjs",
])
// Only exclude paths the source loader can never admit. Reachable source may
// live in build/ or dist/, and this server publishes previews solely in memory.
const IGNORED_DIRECTORIES = new Set(["node_modules"])
const CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ")

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const sourceRevision = (source: string) =>
  createHash("sha256").update(source).digest("hex")

const isWithinProject = (projectDir: string, filePath: string) => {
  const relativePath = path.relative(projectDir, filePath)
  return relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
}

const readJsonBody = async (request: Request): Promise<Record<string, unknown>> => {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "This endpoint requires application/json")
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0)
  if (declaredLength > MAX_REQUEST_BYTES) {
    throw new RequestError(413, "Request body exceeds the standalone source size limit")
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  const reader = request.body?.getReader()
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_REQUEST_BYTES) {
          await reader.cancel()
          throw new RequestError(413, "Request body exceeds the standalone source size limit")
        }
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new RequestError(400, "Request body must be valid JSON")
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(400, "Request body must be a JSON object")
  }
  return body as Record<string, unknown>
}

const requireFields = (body: Record<string, unknown>, fields: string[]) => {
  if (Object.keys(body).length !== fields.length || fields.some((field) => !(field in body))) {
    throw new RequestError(400, `Expected request fields: ${fields.join(", ") || "none"}`)
  }
}

/** Serve a trusted local circuit project through one bound loopback origin. */
export async function startStandaloneDevServer(
  entryFile: string,
  options: StandaloneDevOptions,
) {
  const port = options.port ?? 3020
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Dev server port must be an integer between 0 and 65535")
  }
  if (options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error("Render timeout must be a positive number of milliseconds")
  }
  const requestedEntryPath = path.resolve(entryFile)
  const entryDirectory = await realpath(path.dirname(requestedEntryPath))
  const entryPath = path.join(entryDirectory, path.basename(requestedEntryPath))
  let projectDir = entryDirectory
  if (options.projectDir !== undefined) {
    projectDir = await realpath(path.resolve(options.projectDir))
    if (!(await stat(projectDir)).isDirectory()) throw new Error("Circuit project directory was not found")
  } else {
    const currentDirectory = await realpath(process.cwd())
    if (isWithinProject(currentDirectory, entryPath)) projectDir = currentDirectory
  }
  if (!isWithinProject(projectDir, entryPath) || entryPath.split(path.sep).includes("node_modules")) {
    throw new Error("Circuit entry must be inside the project directory and outside node_modules")
  }
  if (!SOURCE_EXTENSIONS.has(path.extname(entryPath)) || /\.d\.(?:ts|mts|cts)$/.test(entryPath)) {
    throw new Error("Dev requires a TS, TSX, JS, JSX or JSON circuit source file")
  }
  const relativeEntryPath = path.relative(projectDir, entryPath).split(path.sep).join("/")
  const resolveEntry = async () => {
    let resolvedPath: string
    try {
      resolvedPath = await realpath(entryPath)
    } catch {
      throw new RequestError(404, `Circuit entry ${relativeEntryPath} was not found`)
    }
    if (!isWithinProject(projectDir, resolvedPath) || resolvedPath.split(path.sep).includes("node_modules")) {
      throw new RequestError(403, "Circuit entry follows a symlink outside the project directory")
    }
    const entryStat = await stat(resolvedPath)
    if (!entryStat.isFile()) throw new RequestError(400, "Circuit entry must be a source file")
    if (entryStat.size > MAX_SOURCE_BYTES) throw new RequestError(413, "Circuit entry exceeds the 2 MiB source size limit")
    return { resolvedPath, entryStat }
  }
  const readSource = async (): Promise<StandaloneDevSource> => {
    const { resolvedPath } = await resolveEntry()
    const source = await readFile(resolvedPath, "utf8")
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
      throw new RequestError(413, "Circuit entry exceeds the 2 MiB source size limit")
    }
    return { path: relativeEntryPath, source, revision: sourceRevision(source) }
  }
  const initialSource = await readSource()
  let state: StandaloneDevState = {
    entryPath: relativeEntryPath,
    sourceRevision: initialSource.revision,
    status: "building",
    generation: 0,
  }
  let stopped = false
  let watcher: FSWatcher | undefined
  let pollingTimer: ReturnType<typeof setInterval> | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let renderQueue: Promise<void> = Promise.resolve()
  let mutationQueue: Promise<void> = Promise.resolve()
  let activeRender: AbortController | undefined

  const queueMutation = <T>(mutate: () => Promise<T>): Promise<T> => {
    const mutation = mutationQueue.then(() => {
      if (stopped) throw new RequestError(503, "Dev server is stopping")
      return mutate()
    })
    mutationQueue = mutation.then(() => undefined, () => undefined)
    return mutation
  }

  const renderGeneration = async (generation: number) => {
    if (stopped || state.generation !== generation) return
    const controller = new AbortController()
    activeRender = controller
    try {
      const source = await readSource()
      if (stopped || state.generation !== generation) return
      state = { ...state, sourceRevision: source.revision }
      const circuitJson = await renderCircuitFile(entryPath, {
        projectDir,
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
      })
      if (stopped || state.generation !== generation) return
      const currentSource = await readSource()
      if (currentSource.revision !== source.revision) {
        queueRender(currentSource.revision)
        return
      }
      const report = inspectCircuitJson(circuitJson, relativeEntryPath)
      state = {
        entryPath: relativeEntryPath,
        sourceRevision: source.revision,
        status: "ready",
        generation,
        circuitJson,
        report,
      }
    } catch (error) {
      if (stopped || state.generation !== generation) return
      state = {
        entryPath: relativeEntryPath,
        sourceRevision: state.sourceRevision,
        status: "error",
        generation,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      if (activeRender === controller) activeRender = undefined
    }
  }

  const queueRender = (revision = state.sourceRevision, debounceMs = 50) => {
    if (stopped) return
    activeRender?.abort(new Error("A newer circuit revision superseded this render"))
    clearTimeout(debounceTimer)
    const generation = state.generation + 1
    state = {
      entryPath: relativeEntryPath,
      sourceRevision: revision,
      status: "building",
      generation,
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      renderQueue = renderQueue.then(() => renderGeneration(generation))
    }, debounceMs)
  }

  const saveSource = async (body: Record<string, unknown>) => {
    requireFields(body, ["source", "expectedRevision"])
    if (typeof body.source !== "string" || typeof body.expectedRevision !== "string") {
      throw new RequestError(400, "Source and expectedRevision must be strings")
    }
    if (Buffer.byteLength(body.source) > MAX_SOURCE_BYTES) {
      throw new RequestError(413, "Circuit entry exceeds the 2 MiB source size limit")
    }
    const source = body.source
    const expectedRevision = body.expectedRevision
    return queueMutation(async () => {
      const previousSource = await readSource()
      if (previousSource.revision !== expectedRevision) {
        throw new RequestError(409, "Circuit source changed on disk. Reload it before saving.")
      }
      const { resolvedPath, entryStat } = await resolveEntry()
      const temporaryPath = path.join(path.dirname(resolvedPath), `.tsci-save-${randomUUID()}.tmp`)
      try {
        await writeFile(temporaryPath, source, { flag: "wx", mode: entryStat.mode })
        const currentSource = await readSource()
        if (currentSource.revision !== expectedRevision ||
          (await resolveEntry()).resolvedPath !== resolvedPath) {
          throw new RequestError(409, "Circuit source changed on disk. Reload it before saving.")
        }
        await rename(temporaryPath, resolvedPath)
      } finally {
        await rm(temporaryPath, { force: true })
      }
      const result = { path: relativeEntryPath, source, revision: sourceRevision(source) }
      queueRender(result.revision)
      return result
    })
  }

  const importPart = async (body: Record<string, unknown>): Promise<StandaloneDevImport> => {
    requireFields(body, ["supplierPartNumber"])
    if (typeof body.supplierPartNumber !== "string") {
      throw new RequestError(400, "supplierPartNumber must be a string")
    }
    let part: ReturnType<typeof getBundledPart>
    try {
      part = getBundledPart(body.supplierPartNumber)
    } catch (error) {
      throw new RequestError(404, error instanceof Error ? error.message : String(error))
    }
    return queueMutation(async () => {
      const importsDirectory = path.join(projectDir, "imports")
      await mkdir(importsDirectory, { recursive: true })
      const resolvedDirectory = await realpath(importsDirectory)
      if (!isWithinProject(projectDir, resolvedDirectory) || resolvedDirectory.split(path.sep).includes("node_modules")) {
        throw new RequestError(403, "Imports directory follows a symlink outside the project directory")
      }
      const importPath = path.join(resolvedDirectory, `${part.supplierPartNumber}.tsx`)
      const source = generateBundledComponentTsx(part)
      try {
        await writeFile(importPath, source, { flag: "wx" })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new RequestError(409, `Import ${part.supplierPartNumber}.tsx already exists and was preserved`)
        }
        throw error
      }
      queueRender()
      return { path: `imports/${part.supplierPartNumber}.tsx`, source }
    })
  }

  const headers = (contentType: string): HeadersInit => ({
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": CSP,
  })
  const json = (body: unknown, status = 200, isHead = false) =>
    new Response(isHead ? null : JSON.stringify(body), { status, headers: headers("application/json; charset=utf-8") })

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: MAX_REQUEST_BYTES,
    async fetch(request, server) {
      try {
        const url = new URL(request.url)
        const localUrl = new URL(`http://127.0.0.1:${server.port}`)
        const authority = localUrl.host
        if (request.headers.get("host") !== authority || url.host !== authority) {
          throw new RequestError(403, "Request host must match this local dev server")
        }
        if (stopped) throw new RequestError(503, "Dev server is stopping")
        if (request.method === "POST") {
          if (request.headers.get("origin") !== localUrl.origin) {
            throw new RequestError(403, "Writes require this dev server's browser origin")
          }
          const body = await readJsonBody(request)
          if (url.pathname === "/api/source") return json(await saveSource(body))
          if (url.pathname === "/api/import") return json(await importPart(body), 201)
          if (url.pathname === "/api/render") {
            requireFields(body, [])
            queueRender(undefined, 0)
            return json(state, 202)
          }
          return json({ error: "Endpoint was not found" }, 404)
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          return json({ error: "Method is not supported" }, 405)
        }
        const isHead = request.method === "HEAD"
        if (url.pathname === "/api/state") return json(state, 200, isHead)
        if (url.pathname === "/api/source") return json(await readSource(), 200, isHead)
        if (url.pathname === "/api/catalog") return json({ parts: bundledCatalog.parts }, 200, isHead)
        const asset = options.assets[url.pathname]
        if (asset) {
          return new Response(request.method === "HEAD" ? null :
            typeof asset.content === "string" ? asset.content : new Uint8Array(asset.content).buffer,
          { headers: headers(asset.contentType) })
        }
        return json({ error: "Endpoint was not found" }, 404, isHead)
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) },
          error instanceof RequestError ? error.status : 500, request.method === "HEAD")
      }
    },
  })

  const watchChange = (_event: string, filename: string | Buffer | null) => {
    const relativePath = filename?.toString()
    if (relativePath && relativePath.split(/[\\/]/).some((segment) => IGNORED_DIRECTORIES.has(segment))) return
    if (!relativePath || !path.extname(relativePath) || SOURCE_EXTENSIONS.has(path.extname(relativePath))) {
      queueRender()
    }
  }
  // Native directory watching handles atomic saves and previously missing files.
  // A bounded graph poll is the portability fallback when recursive watch is unavailable.
  const startPolling = () => {
    let previousFingerprint: string | undefined
    let polling = false
    pollingTimer = setInterval(async () => {
      if (stopped || polling) return
      polling = true
      try {
        let fingerprint: string
        try {
          fingerprint = sourceRevision(JSON.stringify(await readCircuitProject(entryPath, { projectDir })))
        } catch (error) {
          const source = await readSource().catch(() => undefined)
          fingerprint = `${source?.revision ?? "missing"}:${error instanceof Error ? error.message : String(error)}`
        }
        if (previousFingerprint !== fingerprint) queueRender()
        previousFingerprint = fingerprint
      } finally {
        polling = false
      }
    }, 500)
  }
  try {
    watcher = watch(projectDir, { recursive: true }, watchChange)
    watcher.on("error", () => {
      watcher?.close()
      watcher = undefined
      if (!stopped && !pollingTimer) startPolling()
    })
  } catch {
    startPolling()
  }
  queueRender(initialSource.revision, 0)

  return {
    url: `http://127.0.0.1:${server.port}`,
    server,
    async stop() {
      if (stopped) return
      stopped = true
      clearTimeout(debounceTimer)
      clearInterval(pollingTimer)
      watcher?.close()
      activeRender?.abort(new Error("Dev server stopped"))
      await Promise.all([renderQueue, mutationQueue])
      await waitForCircuitWorkerTeardown()
      await server.stop(true)
    },
  }
}
