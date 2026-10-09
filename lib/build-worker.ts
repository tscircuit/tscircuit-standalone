import type { RootCircuit } from "@tscircuit/core"
import type { AnyCircuitElement } from "circuit-json"
import { bundledCatalog, getBundledPart } from "./catalog"
import type { StandaloneBuildJob, StandaloneBuildResult } from "./build-types"
import {
  createStandaloneFetch,
  createStandalonePlatformConfig,
  OfflineRequestError,
} from "./platform"

const rejectedRequests: string[] = []
const standaloneFetch = createStandaloneFetch()

// Install the policy before loading eval or its providers. A blocked request
// still fails the build if an upstream provider catches its rejection.
const buildFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      return await standaloneFetch(input, init)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      rejectedRequests.push(message)
      throw error
    }
  },
  {
    preconnect: (url: string | URL): never => {
      const error = new OfflineRequestError("PRECONNECT", String(url))
      rejectedRequests.push(error.message)
      throw error
    },
  },
) as typeof fetch
globalThis.fetch = buildFetch

const rejectProvider = (message: string): never => {
  rejectedRequests.push(message)
  throw new Error(message)
}

const createBuildPlatform = () => {
  const platform = createStandalonePlatformConfig()
  return {
    ...platform,
    platformFetch: buildFetch,
    footprintLibraryMap: {
      ...platform.footprintLibraryMap,
      kicad: async (name: string) =>
        rejectProvider(
          `KiCad library footprint ${name} is not bundled in tscircuit standalone. Use a local footprinter string.`,
        ),
    },
    footprintFileParserMap: {
      kicad_mod: {
        loadFromUrl: async (url: string) =>
          rejectProvider(
            `KiCad file footprint ${url} is not supported by this standalone build. Use a local footprinter string.`,
          ),
      },
    },
    spiceEngineMap: {
      ngspice: {
        simulate: async () =>
          rejectProvider("Analog simulation is not bundled in this standalone build."),
      },
    },
  }
}

/** Inspect authored providers before core starts any render effects. */
const validateAuthoredCircuit = (circuit: RootCircuit) => {
  const components = [...circuit.children]
  while (components.length > 0) {
    const component = components.pop()!
    components.push(...component.children)
    const { partsEngine, autorouter } = component.props
    if (partsEngine !== undefined) {
      throw new Error(
        `Custom parts engines on ${component.getDisplayName()} are unsupported in standalone builds. The bundled parts engine is required.`,
      )
    }
    const preset = typeof autorouter === "string" ? autorouter : autorouter?.preset
    if (
      preset?.replace(/-/g, "_") === "auto_cloud" ||
      (typeof autorouter === "object" && autorouter &&
        (autorouter.local === false || autorouter.serverUrl || autorouter.serverMode ||
          autorouter.serverCacheEnabled === true))
    ) {
      throw new Error(
        `Remote autorouting on ${component.getDisplayName()} is unavailable in standalone builds. Use the default local autorouter.`,
      )
    }
  }
}

const normalizeMpn = (manufacturerPartNumber: string) =>
  manufacturerPartNumber.trim().toUpperCase()

const validateSourceParts = (circuitJson: AnyCircuitElement[]) => {
  for (const sourceComponent of circuitJson) {
    if (sourceComponent.type !== "source_component") continue
    const name = sourceComponent.name || "unnamed component"
    const manufacturerPartNumber = sourceComponent.manufacturer_part_number
    const supplierParts = Object.entries(sourceComponent.supplier_part_numbers ?? {})
    for (const [supplier, supplierPartNumbers] of supplierParts) {
      if (!supplierPartNumbers?.length) continue
      if (supplier !== "jlcpcb") {
        throw new Error(
          `Supplier ${supplier} on ${name} is not supported by the bundled catalog.`,
        )
      }
      for (const supplierPartNumber of supplierPartNumbers) {
        const part = getBundledPart(supplierPartNumber)
        if (
          manufacturerPartNumber &&
          normalizeMpn(part.manufacturerPartNumber) !== normalizeMpn(manufacturerPartNumber)
        ) {
          throw new Error(
            `Part ${supplierPartNumber} on ${name} is ${part.manufacturerPartNumber}, which does not match declared manufacturer part ${manufacturerPartNumber}.`,
          )
        }
      }
    }
    if (
      manufacturerPartNumber &&
      !bundledCatalog.parts.some(
        (part) => normalizeMpn(part.manufacturerPartNumber) === normalizeMpn(manufacturerPartNumber),
      )
    ) {
      throw new Error(
        `Manufacturer part ${manufacturerPartNumber} on ${name} is not bundled in tscircuit standalone. No network lookup was attempted.`,
      )
    }
  }
}

const requireEmbeddedAsset = (url: string | undefined, label: string) => {
  if (!url) return
  // This build does not package filesystem, blob, or remote viewer assets.
  if (!url.startsWith("data:")) {
    throw new Error(
      `${label} ${url} is not embedded in this standalone build. Use a procedural footprinter model or inline asset.`,
    )
  }
}

const validateAssetsAndPartMisses = (circuitJson: AnyCircuitElement[]) => {
  for (const element of circuitJson) {
    if (
      element.type === "source_part_not_found_warning" ||
      element.type === "external_footprint_load_error" ||
      element.type === "circuit_json_footprint_load_error"
    ) {
      throw new Error(element.message)
    }
    if (element.type === "cad_component") {
      for (const url of [
        element.model_obj_url,
        element.model_stl_url,
        element.model_3mf_url,
        element.model_gltf_url,
        element.model_glb_url,
        element.model_step_url,
        element.model_wrl_url,
        element.model_asset?.url,
      ]) {
        requireEmbeddedAsset(url, "CAD model asset")
      }
    }
    if (element.type === "schematic_graphic") {
      requireEmbeddedAsset(element.asset?.url, "Schematic image asset")
    }
    if (element.type === "pcb_silkscreen_graphic") {
      requireEmbeddedAsset(element.image_asset?.url, "Silkscreen image asset")
    }
  }
}

const executeBuild = async (job: StandaloneBuildJob): Promise<AnyCircuitElement[]> => {
  const { CircuitRunner } = await import("@tscircuit/eval/eval")
  // Bun 1.3.12 can crash if a worker is terminated while its bundled eval
  // dependency graph is still initializing. Let the host defer termination
  // until this point; user circuit execution has not started yet.
  self.postMessage({ type: "worker_ready" })
  const runner = new CircuitRunner({
    platform: createBuildPlatform(),
    snippetsApiBaseUrl: "standalone://registry",
    cjsRegistryUrl: "standalone://registry",
  })
  const effectErrors: string[] = []
  runner.on("asyncEffect:end", (effect: { error?: string }) => {
    if (effect.error) effectErrors.push(effect.error)
  })
  await runner.setDisableCdnLoading(true)
  await runner.executeWithFsMap(job)
  const circuit = runner._executionContext?.circuit
  if (!circuit) throw new Error("Standalone evaluation did not create a circuit.")
  validateAuthoredCircuit(circuit)
  await runner.renderUntilSettled()
  const circuitJson = await runner.getCircuitJson()
  if (rejectedRequests.length > 0) throw new Error(rejectedRequests[0])
  if (effectErrors.length > 0) throw new Error(effectErrors[0])
  validateSourceParts(circuitJson)
  validateAssetsAndPartMisses(circuitJson)
  return circuitJson
}

self.onmessage = async (event: MessageEvent<StandaloneBuildJob>) => {
  let result: StandaloneBuildResult
  try {
    result = { ok: true, circuitJson: await executeBuild(event.data) }
  } catch (error) {
    result = {
      ok: false,
      error: rejectedRequests[0] ?? (error instanceof Error ? error.message : String(error)),
    }
  }
  self.postMessage(result)
}
