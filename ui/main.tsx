import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { RunFrame, type RunFramePlatformConfig } from "@tscircuit/runframe/source"
import { convertCircuitJsonToPcbSvg, convertCircuitJsonToSchematicSvg } from "circuit-to-svg"
import type { StandaloneDevState as DevState } from "../lib/dev-types"
import { configureBundledCad } from "./bundled-cad"
import { configureBundledModules } from "./bundled-modules"
import { createStandalonePlatformConfig } from "../lib/platform"
import { inspectCircuitJson, type CircuitBuildReport } from "../lib/circuit-report"
import type { CircuitJson } from "circuit-json"
import "./app.css"

const platformConfig: RunFramePlatformConfig = {
  ...createStandalonePlatformConfig(),
  telemetryDisabled: true,
  evalCdnLoadingDisabled: true,
  evalVersionSelectionDisabled: true,
  pcbRenderer: "canvas",
}
// Response objects are not transferable through Comlink. Worker request policy
// handles fetch, while plain part/footprint provider results are proxied normally.
delete platformConfig.platformFetch

type Source = { path: string; source: string; revision: string }
type CatalogPart = { supplierPartNumber: string; manufacturerPartNumber: string; exportName: string; description?: string }

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`)
  return result
}

function download(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function App() {
  const [state, setState] = useState<DevState | null>(null)
  const [circuitJson, setCircuitJson] = useState<CircuitJson | null>(null)
  const [report, setReport] = useState<CircuitBuildReport | null>(null)
  const [renderStatus, setRenderStatus] = useState<"building" | "ready" | "error">("building")
  const [completedGeneration, setCompletedGeneration] = useState<number | null>(null)
  const [renderError, setRenderError] = useState("")
  const [source, setSource] = useState<Source | null>(null)
  const [draft, setDraft] = useState("")
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const [actionError, setActionError] = useState("")
  const [catalog, setCatalog] = useState<CatalogPart[] | null>(null)
  const [catalogVisible, setCatalogVisible] = useState(false)
  const [search, setSearch] = useState("")
  const dirtyRef = useRef(false)
  const sourceRef = useRef<Source | null>(null)
  const busyRef = useRef(false)
  const sourceLoadVersion = useRef(0)

  const fsMap = useMemo(() => {
    if (!state?.fsMap || !state.mainComponentPath) return {}
    return {
      ...state.fsMap,
      [state.mainComponentPath]: state.mainComponentPath.endsWith(".json")
        ? state.fsMap[state.mainComponentPath]!
        : `// Standalone revision ${state.generation}\n${state.fsMap[state.mainComponentPath]}`,
    }
  }, [state?.generation, state?.fsMap, state?.mainComponentPath])

  // Cached JSON uses RunFrame's existing static-file path. No evaluation is
  // required when reloading an unchanged, already validated JSON document.
  useEffect(() => {
    const path = state?.mainComponentPath
    if (state?.status !== "ready" || !path?.endsWith(".circuit.json") || !state.fsMap) return
    const json = JSON.parse(state.fsMap[path]!) as CircuitJson
    setCircuitJson(json)
    setReport(inspectCircuitJson(json, state.entryPath))
    setCompletedGeneration(state.generation)
    setRenderStatus("ready")
    setRenderError("")
  }, [state?.generation, state?.status, state?.mainComponentPath, state?.fsMap])

  const loadSource = useCallback(async (force = false) => {
    const version = ++sourceLoadVersion.current
    const next = await api<Source>("/api/source")
    if (version !== sourceLoadVersion.current) return
    if (force || !dirtyRef.current) {
      sourceRef.current = next
      dirtyRef.current = false
      setSource(next)
      setDraft(next.source)
      setDirty(false)
    }
  }, [])

  const refresh = useCallback(async () => {
    const next = await api<DevState>("/api/state")
    setState((previous) => {
      if (previous && (next.generation < previous.generation ||
        (next.generation === previous.generation && previous.status !== "building" && next.status === "building"))) return previous
      return previous?.generation === next.generation && previous.status === next.status && previous.sourceRevision === next.sourceRevision ? previous : next
    })
    if (next.sourceRevision !== sourceRef.current?.revision && !busyRef.current) await loadSource()
  }, [loadSource])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        await refresh()
      } catch (error) {
        if (!stopped) setActionError(error instanceof Error ? error.message : String(error))
      }
      if (!stopped) timer = setTimeout(poll, 800)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [refresh])

  const save = async () => {
    if (!sourceRef.current || busyRef.current) return
    busyRef.current = true
    sourceLoadVersion.current++
    setSaving(true)
    setActionError("")
    setNotice("")
    try {
      const next = await api<Source>("/api/source", { source: draft, expectedRevision: sourceRef.current.revision })
      sourceRef.current = next
      dirtyRef.current = false
      setSource(next)
      setDirty(false)
      setNotice("Saved")
      await refresh()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      busyRef.current = false
      setSaving(false)
    }
  }

  const rebuild = async () => {
    setActionError("")
    try {
      await api("/api/render", {})
      await refresh()
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)) }
  }

  const openCatalog = async () => {
    setCatalogVisible((visible) => !visible)
    if (catalog) return
    try { setCatalog((await api<{ parts: CatalogPart[] }>("/api/catalog")).parts) }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)) }
  }

  const importPart = async (part: CatalogPart) => {
    setActionError("")
    setNotice("")
    try {
      const imported = await api<{ path: string; source: string }>("/api/import", { supplierPartNumber: part.supplierPartNumber })
      setNotice(`Imported ${part.manufacturerPartNumber} to ${imported.path}`)
      await refresh()
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)) }
  }

  const exportFile = (format: "json" | "pcb" | "schematic") => {
    if (!state || !circuitJson || state.status !== "ready" || completedGeneration !== state.generation || renderStatus !== "ready") return
    const stem = state.entryPath.split(/[\\/]/).at(-1)!.replace(/\.[^.]+$/, "")
    try {
      if (format === "json") download(`${JSON.stringify(circuitJson, null, 2)}\n`, `${stem}.json`, "application/json")
      else {
        const svg = format === "pcb"
          ? convertCircuitJsonToPcbSvg(circuitJson, { width: 1000, height: 800, includeVersion: false })
          : convertCircuitJsonToSchematicSvg(circuitJson, { width: 1200, height: 850, includeVersion: false })
        download(svg, `${stem}.${format}.svg`, "image/svg+xml")
      }
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)) }
  }

  const buildStatus = state?.status === "error" ? "error" : state?.status !== "ready" || completedGeneration !== state.generation ? "building" : renderStatus
  const error = actionError || state?.error || (completedGeneration === state?.generation ? renderError : "")
  const warnings = completedGeneration === state?.generation ? report?.warnings ?? [] : []
  const errors = completedGeneration === state?.generation ? report?.errors ?? [] : []
  const parts = catalog?.filter((part) => `${part.supplierPartNumber} ${part.manufacturerPartNumber} ${part.description ?? ""}`.toLowerCase().includes(search.toLowerCase())) ?? []

  return <main className="app">
    <header className="app-header">
      <div className="identity"><img src="/favicon.svg" alt="" /><div><h1>tscircuit <span>standalone</span></h1><p>{state?.entryPath ?? "Loading circuit…"}</p></div></div>
      <div className="header-actions"><span className="bundled-badge">Bundled</span><button onClick={() => void openCatalog()} aria-expanded={catalogVisible}>Bundled parts</button><button onClick={() => void rebuild()} disabled={buildStatus === "building"}>Rebuild</button></div>
    </header>
    {catalogVisible && <section className="catalog" aria-label="Bundled parts catalog">
      <div className="catalog-heading"><h2>Bundled parts</h2><input aria-label="Search bundled parts" placeholder="Search part number or name" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      <div className="catalog-results">{parts.map((part) => <article key={part.supplierPartNumber}><div><strong>{part.manufacturerPartNumber}</strong><small>{part.supplierPartNumber} · {part.description ?? "Footprinter footprint and pin labels"}</small></div><button onClick={() => void importPart(part)}>Import {part.supplierPartNumber}</button></article>)}{catalog && !parts.length && <p>No bundled parts match this search.</p>}</div>
    </section>}
    <div className="workspace">
      <section className="editor-pane" aria-label="Circuit editor">
        <div className="editor-heading"><h2>Source</h2><span>{dirty ? "Unsaved changes" : "Saved on disk"}</span></div>
        <textarea aria-label="Circuit source" spellCheck={false} value={draft} disabled={!source || saving} onChange={(event) => { setDraft(event.target.value); setDirty(true); dirtyRef.current = true }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "s") { event.preventDefault(); void save() } }} />
        <div className="editor-actions"><button className="primary" onClick={() => void save()} disabled={!source || saving}>{saving ? "Saving…" : "Save and rebuild"}</button><button onClick={() => { setActionError(""); void loadSource(true).catch((error) => setActionError(String(error))) }} disabled={saving}>Reload source</button></div>
        {notice && <p className="notice" role="status">{notice}</p>}
        <div className={`build-summary ${buildStatus}`} data-testid="build-status" data-generation={state?.generation} role="status">{buildStatus === "building" ? "Building circuit…" : buildStatus === "error" ? "Build failed" : `Built · ${report?.elementCounts.pcb_smtpad ?? 0} pads · ${errors.length} errors · ${warnings.length} warnings`}</div>
        {error && <pre className="build-error" data-testid="build-error" role="alert">{error}</pre>}
        {(warnings.length > 0 || errors.length > 0) && <details className="diagnostics"><summary>Diagnostics ({errors.length + warnings.length})</summary>{errors.map((diagnostic, index) => <p className="error" key={`error-${index}`}>{diagnostic.message}</p>)}{warnings.map((diagnostic, index) => <p key={`warning-${index}`}>{diagnostic.message}</p>)}</details>}
      </section>
      <section className="preview-pane" aria-label="Circuit preview">
        <div className="preview-exports"><span>Live preview</span><div><button disabled={!circuitJson || buildStatus !== "ready"} onClick={() => exportFile("json")}>Download Circuit JSON</button><button disabled={!circuitJson || buildStatus !== "ready"} onClick={() => exportFile("pcb")}>Download PCB SVG</button><button disabled={!circuitJson || buildStatus !== "ready"} onClick={() => exportFile("schematic")}>Download Schematic SVG</button></div></div>
        <div className={`runframe${state?.status === "error" ? " graph-error" : ""}`} aria-hidden={state?.status === "error"}><RunFrame
          fsMap={fsMap}
          mainComponentPath={state?.mainComponentPath}
          isLoadingFiles={state?.status !== "ready"}
          evalVersion="0.0.1569"
          evalWebWorkerBlobUrl="/assets/eval-worker.js"
          platformConfig={platformConfig}
          onReportAutoroutingLog={() => { window.open("https://github.com/tscircuit/tscircuit-standalone/issues/new", "_blank", "noopener,noreferrer") }}
          onRenderStarted={() => { setRenderStatus("building"); setRenderError(""); setCircuitJson(null); setReport(null) }}
          onCircuitJsonChange={(json: CircuitJson) => { setCircuitJson(json); setReport(inspectCircuitJson(json, state?.entryPath ?? "circuit")) }}
          onRunCompleted={(result) => {
            setCompletedGeneration(state?.generation ?? null)
            setRenderStatus(result.hasExecutionError ? "error" : "ready")
            if (result.hasExecutionError) {
              setCircuitJson(null)
              setReport(null)
              setRenderError(result.errors?.map((error: { message?: string }) => error.message ?? String(error)).join("\n") ?? "Circuit evaluation failed")
            }
          }}
          availableTabs={["pcb", "schematic", "cad", "bom", "errors", "circuit_json"]}
          defaultActiveTab="pcb"
          showRunButton={false}
          showFileMenu={false}
          showToggleFullScreen={false}
        /></div>
      </section>
    </div>
  </main>
}

const root = createRoot(document.getElementById("root")!)
try {
  configureBundledModules()
  await configureBundledCad()
  root.render(<App />)
} catch (error) {
  root.render(<main className="startup-error"><h1>Could not start the circuit viewer</h1><p>{error instanceof Error ? error.message : String(error)}</p></main>)
}
