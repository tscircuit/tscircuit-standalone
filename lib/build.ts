import { mkdir, writeFile } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { AnyCircuitElement } from "circuit-json"
import {
  convertCircuitJsonToPcbSvg,
  convertCircuitJsonToSchematicSvg,
} from "circuit-to-svg"
import type { StandaloneBuildResult } from "./build-types"
import { readCircuitProject } from "./read-circuit-project"

export interface CircuitBuildReport {
  sourceFile: string
  elementCounts: Record<string, number>
  errors: { type: string; message: string }[]
  warnings: { type: string; message: string }[]
}

export function inspectCircuitJson(
  circuitJson: AnyCircuitElement[],
  sourceFile: string,
): CircuitBuildReport {
  const elementCounts: Record<string, number> = {}
  const errors: CircuitBuildReport["errors"] = []
  const warnings: CircuitBuildReport["warnings"] = []
  for (const element of circuitJson) {
    elementCounts[element.type] = (elementCounts[element.type] ?? 0) + 1
    if (element.type.endsWith("_error") || element.type.endsWith("_warning")) {
      const diagnostic = {
        type: element.type,
        message: "message" in element && typeof element.message === "string"
          ? element.message
              .replace(/<[a-z_]+#\d+\s+name="([^"]+)"\s*\/>/gi,
                (_, name: string) => name.replace(/^\./, ""))
              .replace(/<[a-z_]+#\d+\(([^)]*)\)\s*\/>/gi,
                (_, selector: string) => selector.split(">").at(-1)!.trim().replace(/^\./, ""))
          : element.type.replaceAll("_", " "),
      }
      if (element.type.endsWith("_error")) errors.push(diagnostic)
      else warnings.push(diagnostic)
    }
  }
  return { sourceFile, elementCounts, errors, warnings }
}

/** Evaluate in a fresh embedded worker so network guards and globals are isolated. */
export async function renderCircuitFile(
  filePath: string,
  options: { timeoutMs?: number; projectDir?: string } = {},
): Promise<AnyCircuitElement[]> {
  const project = await readCircuitProject(filePath, { projectDir: options.projectDir })
  const timeoutMs = options.timeoutMs ?? 60_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Build timeout must be a positive number of milliseconds")
  }
  // Compile the worker as a second entrypoint. Bun embeds it with a .js path;
  // source execution resolves this URL to the corresponding .ts module.
  const workerPath = import.meta.url === pathToFileURL(Bun.main).href
    ? "./lib/build-worker.js" : "./build-worker.js"
  const worker = new Worker(new URL(workerPath, import.meta.url).href)
  try {
    return await new Promise<AnyCircuitElement[]>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Circuit build exceeded ${timeoutMs} ms and was stopped`))
      }, timeoutMs)
      worker.onmessage = (event: MessageEvent<StandaloneBuildResult>) => {
        clearTimeout(timer)
        if (event.data.ok) resolveResult(event.data.circuitJson)
        else reject(new Error(event.data.error))
      }
      worker.onerror = (event: ErrorEvent) => {
        clearTimeout(timer)
        reject(new Error(event.message || "Circuit build worker failed"))
      }
      worker.postMessage(project)
    })
  } finally {
    worker.terminate()
  }
}

export async function buildCircuitFile(
  filePath: string,
  options: { outputDir?: string; timeoutMs?: number; projectDir?: string } = {},
) {
  const circuitJson = await renderCircuitFile(filePath, options)
  const stem = basename(filePath, extname(filePath))
  const report = inspectCircuitJson(circuitJson, basename(filePath))
  const outputDir = resolve(options.outputDir ?? "build")
  const outputPaths = {
    circuitJson: join(outputDir, `${stem}.json`),
    pcbSvg: join(outputDir, `${stem}.pcb.svg`),
    schematicSvg: join(outputDir, `${stem}.schematic.svg`),
    report: join(outputDir, `${stem}.report.json`),
  }
  // Render every artifact before creating output files. Unsupported content
  // fails in the worker, so partial offline misses are never published.
  const pcbSvg = convertCircuitJsonToPcbSvg(circuitJson, {
    width: 1000, height: 800, includeVersion: false,
    shouldDrawErrors: true, shouldDrawWarnings: true, showPinNumbers: true,
  })
  const schematicSvg = convertCircuitJsonToSchematicSvg(circuitJson, {
    width: 1200, height: 850, includeVersion: false,
    shouldDrawErrors: true, shouldDrawWarnings: true,
  })
  if (/(?:href|src)\s*=\s*["']https?:\/\//i.test(`${pcbSvg}\n${schematicSvg}`)) {
    throw new Error("Generated preview contains an external asset that is unavailable offline")
  }
  await mkdir(outputDir, { recursive: true })
  await Promise.all([
    writeFile(outputPaths.circuitJson, `${JSON.stringify(circuitJson, null, 2)}\n`),
    writeFile(outputPaths.pcbSvg, pcbSvg),
    writeFile(outputPaths.schematicSvg, schematicSvg),
    writeFile(outputPaths.report, `${JSON.stringify(report, null, 2)}\n`),
  ])
  return { circuitJson, outputPaths, report }
}
