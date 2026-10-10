import type { CircuitJson } from "circuit-json"
import type { Page } from "playwright"

export interface BundledModuleCheckReport {
  namespaces: Record<string, string[]>
  unbundledVersionRejected: boolean
  operations: Record<string, { ok: boolean; error?: string; [key: string]: unknown }>
}

/**
 * Runs inside the real compiled UI. The browser harness must keep its ordinary
 * request, worker, and CSP monitoring active while this function executes.
 * KiCad checks conversion of 2D documents, not fetching referenced 3D models.
 */
export async function checkBundledModules(
  page: Page,
  circuitJson: CircuitJson,
): Promise<BundledModuleCheckReport> {
  const report = await page.evaluate(async (circuitJson): Promise<BundledModuleCheckReport> => {
    const resolver = (globalThis as typeof globalThis & {
      tscircuitDynamicImportResolver?: (
        name: string,
        defaultResolver: (name: string) => Promise<never>,
      ) => unknown | PromiseLike<unknown>
    }).tscircuitDynamicImportResolver
    if (!resolver) throw new Error("The compiled UI did not configure its bundled module resolver")

    const required: Record<string, string[]> = {
      "@tscircuit/circuit-json-schematic-placement-analysis": ["analyzeSchematicPlacement"],
      "circuit-json-to-altium": ["convertCircuitJsonToAltiumZip"],
      "circuit-json-to-bom-csv": ["convertCircuitJsonToBomRows", "convertBomRowsToCsv"],
      "circuit-json-to-fdm-component-box": ["createFdmComponentBox", "renderFdmComponentBoxPng"],
      "circuit-json-to-gerber": ["convertCircuitJsonToGerberFiles"],
      "circuit-json-to-gltf": ["convertCircuitJsonToGltf"],
      "circuit-json-to-kicad": [
        "CircuitJsonToKicadPcbConverter", "CircuitJsonToKicadSchConverter",
        "CircuitJsonToKicadProConverter", "CircuitJsonToKicadLibraryConverter",
        "resolveAndLoadKicad3dModelFiles",
      ],
      "circuit-json-to-lbrn": ["convertCircuitJsonToLbrn"],
      "circuit-json-to-pnp-csv": ["convertCircuitJsonToPickAndPlaceCsv"],
      "circuit-json-to-step": ["circuitJsonToStep"],
      "circuit-to-svg": ["convertCircuitJsonToPinoutSvg"],
      "kicad-to-circuit-json": ["KicadFootprintToCircuitJsonConverter"],
    }
    const forbidFallback = async (name: string): Promise<never> => {
      throw new Error(`Bundled module check attempted the online resolver for ${name}`)
    }
    const modules: Record<string, Record<string, any>> = {}
    const report: BundledModuleCheckReport = {
      namespaces: {}, unbundledVersionRejected: false, operations: {},
    }
    for (const [name, exports] of Object.entries(required)) {
      const namespace = await resolver(name, forbidFallback) as Record<string, any>
      for (const symbol of exports) {
        if (typeof namespace?.[symbol] !== "function") {
          throw new Error(`Bundled module ${name} is missing export ${symbol}`)
        }
      }
      modules[name] = namespace
      report.namespaces[name] = exports
    }
    const analyzerAlias = await resolver("@tscircuit/circuit-json-schematic-placement-analysis@0.0.46", forbidFallback) as Record<string, any>
    if (analyzerAlias.analyzeSchematicPlacement !== modules["@tscircuit/circuit-json-schematic-placement-analysis"]!.analyzeSchematicPlacement) {
      throw new Error("The bundled schematic analyzer version alias resolved a different implementation")
    }
    try {
      await resolver("circuit-json-to-gltf@latest", forbidFallback)
    } catch {
      report.unbundledVersionRejected = true
    }

    const bytes = (text: string) => new TextEncoder().encode(text).byteLength
    const nonempty = (value: string, format: string) => {
      if (typeof value !== "string" || value.length === 0) throw new Error(`${format} output is empty`)
      return value
    }
    const filtered = circuitJson.filter((element) => !("error_type" in element) && !("warning_type" in element))
    let stepText: string | undefined
    const operations: Record<string, () => unknown | Promise<unknown>> = {
      schematicPlacement: async () => {
        const analysis = await modules["@tscircuit/circuit-json-schematic-placement-analysis"]!.analyzeSchematicPlacement(circuitJson)
        const issues = analysis.getIssues()
        if (!Array.isArray(issues)) throw new Error("Schematic placement analysis did not return issues")
        return { issues: issues.length }
      },
      bom: async () => {
        const converter = modules["circuit-json-to-bom-csv"]!
        const rows = await converter.convertCircuitJsonToBomRows({ circuitJson })
        const csv = nonempty(await converter.convertBomRowsToCsv(rows), "BOM CSV")
        return { rows: rows.length, csvBytes: bytes(csv) }
      },
      pnp: () => {
        const csv = nonempty(modules["circuit-json-to-pnp-csv"]!.convertCircuitJsonToPickAndPlaceCsv(circuitJson, { supplier: "jlcpcb" }), "Pick-and-place CSV")
        return { csvBytes: bytes(csv) }
      },
      gerber: () => {
        const files = modules["circuit-json-to-gerber"]!.convertCircuitJsonToGerberFiles(filtered)
        if (Object.keys(files).length === 0) throw new Error("Gerber export produced no files")
        for (const content of Object.values(files)) nonempty(content as string, "Gerber")
        return { files: Object.keys(files).length }
      },
      pinout: () => {
        const svg = nonempty(modules["circuit-to-svg"]!.convertCircuitJsonToPinoutSvg(circuitJson), "Pinout SVG")
        if (!svg.includes("<svg")) throw new Error("Pinout output is not SVG")
        return { svgBytes: bytes(svg) }
      },
      kicad: () => {
        const converter = modules["circuit-json-to-kicad"]!
        const output: Record<string, unknown> = {}
        for (const [name, Constructor] of Object.entries({
          pcb: converter.CircuitJsonToKicadPcbConverter,
          sch: converter.CircuitJsonToKicadSchConverter,
          pro: converter.CircuitJsonToKicadProConverter,
        })) {
          const instance = new Constructor(circuitJson, { projectName: "StandaloneAudit", includeBuiltin3dModels: true })
          instance.runUntilFinished()
          const text = nonempty(instance.getOutputString(), `KiCad ${name}`)
          if (name === "pro") JSON.parse(text)
          else if (!text.includes(name === "pcb" ? "(kicad_pcb" : "(kicad_sch")) throw new Error(`Invalid KiCad ${name} document`)
          output[`${name}Bytes`] = bytes(text)
          if (name === "pcb") output.modelPaths = instance.getModel3dSourcePaths()
        }
        const library = new converter.CircuitJsonToKicadLibraryConverter(circuitJson, {
          libraryName: "StandaloneAudit", footprintLibraryName: "StandaloneAudit",
        })
        library.runUntilFinished()
        const result = library.getOutput()
        output.librarySymbolBytes = bytes(nonempty(result.kicadSymString, "KiCad symbol library"))
        output.footprints = result.footprints.length
        return output
      },
      kicadImport: () => {
        const converter = new modules["kicad-to-circuit-json"]!.KicadFootprintToCircuitJsonConverter()
        converter.addFile("StandaloneAudit.kicad_mod", '(footprint "StandaloneAudit" (layer "F.Cu") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))')
        converter.runUntilFinished()
        const result = converter.getOutput()
        if (!result.some((element: { type: string }) => element.type === "pcb_smtpad")) throw new Error("Local KiCad import produced no SMT pad")
        return { elements: result.length }
      },
      fdm: async () => {
        const converter = modules["circuit-json-to-fdm-component-box"]!
        const result = await converter.createFdmComponentBox(circuitJson)
        if (result.threeMf[0] !== 80 || result.threeMf[1] !== 75) throw new Error("Component box output is not a 3MF ZIP")
        const png = await converter.renderFdmComponentBoxPng(circuitJson, {}, { width: 320, height: 240 })
        if (png[0] !== 137 || png[1] !== 80 || png[2] !== 78 || png[3] !== 71) throw new Error("Component box preview is not PNG")
        return { threeMfBytes: result.threeMf.length, pngBytes: png.length, dimensions: result.dimensions }
      },
      lbrn: async () => {
        const project = await modules["circuit-json-to-lbrn"]!.convertCircuitJsonToLbrn(circuitJson, { includeOxidationCleaningLayer: true })
        const xml = nonempty(project.toXml(), "LightBurn XML")
        if (!xml.includes("<LightBurnProject")) throw new Error("LightBurn output is not a project")
        return { xmlBytes: bytes(xml) }
      },
      glb: async () => {
        const result = await modules["circuit-json-to-gltf"]!.convertCircuitJsonToGltf(circuitJson, { format: "glb", boardTextureResolution: 128 })
        if (!(result instanceof ArrayBuffer) || result.byteLength < 12 || new DataView(result).getUint32(0, true) !== 0x46546c67) throw new Error("GLB export has an invalid header")
        return { glbBytes: result.byteLength }
      },
      step: async () => {
        stepText = await modules["circuit-json-to-step"]!.circuitJsonToStep(circuitJson, { includeComponents: true, includeExternalMeshes: false })
        if (!stepText?.includes("ISO-10303-21")) throw new Error("STEP export has an invalid header")
        return { stepBytes: bytes(stepText) }
      },
      occt: async () => {
        if (!stepText) throw new Error("STEP export failed before OCCT qualification")
        // This is an ordinary embedded asset, loaded from the compiled binary's
        // server. It uses no testing-only UI namespace or bare browser import.
        const moduleUrl = "/assets/occt-import-js.js"
        const { default: createOcct } = await import(moduleUrl)
        const occt = await createOcct({ locateFile: () => "/assets/occt-import-js.wasm" })
        const result = occt.ReadStepFile(new TextEncoder().encode(stepText), { linearUnit: "millimeter" })
        if (!result.success || result.meshes.length === 0) throw new Error("OCCT could not parse exported STEP geometry")
        return { meshes: result.meshes.length }
      },
      altium: async () => {
        const result = await modules["circuit-json-to-altium"]!.convertCircuitJsonToAltiumZip(circuitJson, "StandaloneAudit")
        if (result[0] !== 80 || result[1] !== 75) throw new Error("Altium output is not a ZIP")
        return { zipBytes: result.length }
      },
    }
    for (const [name, run] of Object.entries(operations)) {
      try {
        report.operations[name] = { ok: true, ...await run() as Record<string, unknown> }
      } catch (error) {
        report.operations[name] = { ok: false, error: String(error) }
      }
    }
    return report
  }, circuitJson)

  const failures = Object.entries(report.operations)
    .filter(([, result]) => !result.ok)
    .map(([name, result]) => new Error(`${name}: ${result.error}`))
  if (!report.unbundledVersionRejected) failures.push(new Error("The resolver accepted an unbundled latest version"))
  if (failures.length) throw new AggregateError(failures, "Compiled UI bundled converter checks failed")
  return report
}
