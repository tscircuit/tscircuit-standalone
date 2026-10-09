import { evalWorkerPolicy } from "./eval-worker-bootstrap"
import { CircuitRunner } from "@tscircuit/eval/eval"
import { expose } from "comlink"
import {
  validateAuthoredCircuit,
  validateStandaloneCircuitJson,
} from "../lib/circuit-policy"
import { createStandalonePlatformConfig } from "../lib/platform"

const platform = createStandalonePlatformConfig()
platform.footprintLibraryMap = {
  ...platform.footprintLibraryMap,
  kicad: async (name) =>
    evalWorkerPolicy.reject(
      `KiCad library footprint ${name} is not bundled in tscircuit standalone. Use a local footprinter string.`,
    ),
}
platform.footprintFileParserMap = {
  kicad_mod: {
    loadFromUrl: async (url) =>
      evalWorkerPolicy.reject(
        `KiCad file footprint ${url} is not supported by this standalone build. Use a local footprinter string.`,
      ),
  },
}
platform.spiceEngineMap = {
  ngspice: {
    simulate: async () =>
      evalWorkerPolicy.reject(
        "Analog simulation is not bundled in this standalone build.",
      ),
  },
}

class StandaloneCircuitRunner extends CircuitRunner {
  private hasExecuted = false
  private effectErrors: string[] = []

  private beginExecution() {
    // Never erase a request rejected during worker initialization.
    if (!this.hasExecuted) evalWorkerPolicy.assertNoRejectedRequests()
    this.hasExecuted = true
    evalWorkerPolicy.clear()
    this.effectErrors = []
  }

  private validateExecution() {
    evalWorkerPolicy.assertNoRejectedRequests()
    const circuit = this._executionContext?.circuit
    if (!circuit)
      throw new Error("Standalone evaluation did not create a circuit.")
    validateAuthoredCircuit(circuit)
    circuit.on("asyncEffect:end", (event: { error?: string }) => {
      if (event.error) this.effectErrors.push(event.error)
    })
  }

  async executeWithFsMap(
    options: Parameters<CircuitRunner["executeWithFsMap"]>[0],
  ) {
    this.beginExecution()
    await super.executeWithFsMap(options)
    this.validateExecution()
  }

  async execute(...args: Parameters<CircuitRunner["execute"]>) {
    this.beginExecution()
    await super.execute(...args)
    this.validateExecution()
  }

  async executeComponent(
    ...args: Parameters<CircuitRunner["executeComponent"]>
  ) {
    this.beginExecution()
    await super.executeComponent(...args)
    this.validateExecution()
  }

  async renderUntilSettled() {
    await super.renderUntilSettled()
    evalWorkerPolicy.assertNoRejectedRequests()
    if (this.effectErrors.length > 0) throw new Error(this.effectErrors[0])
  }

  async getCircuitJson() {
    evalWorkerPolicy.assertNoRejectedRequests()
    if (this.effectErrors.length > 0) throw new Error(this.effectErrors[0])
    const circuitJson = await super.getCircuitJson()
    // RunFrame asks for initial and final snapshots. Validate both before they
    // cross Comlink so a viewer never receives a remote model/image URL.
    validateStandaloneCircuitJson(circuitJson)
    return circuitJson
  }
}

const runner = new StandaloneCircuitRunner({
  platform,
  snippetsApiBaseUrl: "standalone://registry",
  cjsRegistryUrl: "standalone://registry",
})
// The setter changes configuration synchronously; expose immediately so the
// ordinary createCircuitWebWorker initialization messages have a receiver.
void runner.setDisableCdnLoading(true)
expose(runner)
