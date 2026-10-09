import type { AnyCircuitElement } from "circuit-json"
import { validateAuthoredCircuit, validateStandaloneCircuitJson } from "./circuit-policy"
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
  validateStandaloneCircuitJson(circuitJson)
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
