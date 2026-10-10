import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderCircuitFile, waitForCircuitWorkerTeardown } from "../lib/build"

test("a native render timeout rejects before deferred bootstrap cleanup and permits another build", async () => {
  const directory = await mkdtemp(join(tmpdir(), "standalone-worker-timeout-"))
  const entry = join(directory, "index.tsx")
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await writeFile(entry, `export default () => <board width="10mm" height="10mm"><resistor name="R1" resistance="1k" footprint="0603"/></board>`)
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => reject(new Error("Render timeout did not reject within five seconds")), 5_000)
    })
    try {
      await expect(Promise.race([
        renderCircuitFile(entry, { projectDir: directory, timeoutMs: 1 }),
        deadline,
      ])).rejects.toThrow("exceeded 1 ms")
    } finally {
      clearTimeout(deadlineTimer)
      await waitForCircuitWorkerTeardown()
    }
    const circuitJson = await renderCircuitFile(entry, { projectDir: directory, timeoutMs: 15_000 })
    const component = circuitJson.find((element) => element.type === "source_component" && element.name === "R1")
    expect(component && "resistance" in component ? component.resistance : undefined).toBe(1000)
    expect(await readdir(directory)).toEqual(["index.tsx"])
  } finally {
    clearTimeout(deadlineTimer)
    await waitForCircuitWorkerTeardown()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
