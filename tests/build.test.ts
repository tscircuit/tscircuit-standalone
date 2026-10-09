import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildCircuitFile, renderCircuitFile } from "../lib/build"
import { runCli } from "../cli/main"
import { schematicPortReachesNetLabel } from "./helpers/schematic-connectivity"

const example = (name: string) => resolve(import.meta.dir, `../examples/${name}.circuit.tsx`)

test("DRC errors retain inspectable artifacts and return a failing CLI status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "standalone-drc-"))
  try {
    const entry = join(dir, "overlap.tsx")
    const outputDir = join(dir, "output")
    await writeFile(entry, `export default () => <board width="10mm" height="10mm"><resistor name="R1" resistance="1k" footprint="0603" pcbX={0} pcbY={0}/><resistor name="R2" resistance="2k" footprint="0603" pcbX={0} pcbY={0}/></board>`)
    let stderr = ""
    const status = await runCli(["build", entry, "--output-dir", outputDir], {
      stdout: () => {}, stderr: (message) => { stderr += message },
    })
    expect(status).toBe(1)
    expect(stderr).toBe("")
    const report = JSON.parse(await readFile(join(outputDir, "overlap.report.json"), "utf8"))
    expect(report.errors.some((error: { type: string }) => error.type === "pcb_footprint_overlap_error")).toBe(true)
    expect(await readFile(join(outputDir, "overlap.pcb.svg"), "utf8")).toContain("<svg")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)

test("LED circuit routes and emits local previews with only unsourced BOM warnings", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "standalone-led-"))
  try {
    const result = await buildCircuitFile(example("led-resistor"), { outputDir })
    expect(result.report.errors).toEqual([])
    expect(result.report.warnings.filter((warning) => warning.type === "source_missing_manufacturer_part_number_warning")).toHaveLength(2)
    expect(result.report.warnings.every((warning) => warning.type === "source_missing_manufacturer_part_number_warning" || warning.type.includes("sheet"))).toBe(true)
    expect(result.report.elementCounts.pcb_smtpad).toBe(6)
    expect(result.report.elementCounts.pcb_trace).toBeGreaterThan(0)
    expect(await readFile(result.outputPaths.pcbSvg, "utf8")).toContain("<svg")
    expect(await readFile(result.outputPaths.schematicSvg, "utf8")).toContain("data-schematic-component-id")
  } finally {
    await rm(outputDir, { recursive: true, force: true })
  }
}, 30_000)

test("RP2040 imported component preserves all physical pads and routes thermal ground", async () => {
  const circuitJson = await renderCircuitFile(example("rp2040-breakout"))
  const chip = circuitJson.find((element) => element.type === "source_component" && element.name === "U1")!
  if (chip.type !== "source_component") throw new Error("Missing U1 source component")
  const pcbChip = circuitJson.find((element) => element.type === "pcb_component" && element.source_component_id === chip.source_component_id)!
  if (pcbChip.type !== "pcb_component") throw new Error("Missing U1 PCB component")
  const pads = circuitJson.filter((element) => element.type === "pcb_smtpad" && element.pcb_component_id === pcbChip.pcb_component_id)
  expect(pads).toHaveLength(57)
  const ground = circuitJson.find((element) => element.type === "source_port" && element.source_component_id === chip.source_component_id && element.pin_number === 57)!
  if (ground.type !== "source_port") throw new Error("Missing thermal ground source port")
  expect(ground.port_hints).toContain("GND")
  const pcbGround = circuitJson.find((element) => element.type === "pcb_port" && element.source_port_id === ground.source_port_id)!
  if (pcbGround.type !== "pcb_port") throw new Error("Missing thermal ground PCB port")
  const thermal = pads.find((element) => element.type === "pcb_smtpad" && element.pcb_port_id === pcbGround.pcb_port_id)!
  if (thermal.type !== "pcb_smtpad" || thermal.shape !== "rect") throw new Error("Missing thermal pad")
  expect(thermal.width).toBe(3.1)
  expect(thermal.height).toBe(3.1)
  expect(circuitJson.some((element) => element.type === "source_trace" && element.connected_source_port_ids.includes(ground.source_port_id))).toBe(true)
  expect(circuitJson.some((element) => element.type === "pcb_trace" && element.route.some((segment) => segment.route_type === "wire" && segment.start_pcb_port_id === pcbGround.pcb_port_id || segment.route_type === "wire" && segment.end_pcb_port_id === pcbGround.pcb_port_id))).toBe(true)
  expect(circuitJson.filter((element) => element.type.endsWith("_error"))).toEqual([])
  for (const [name, pin, net] of [
    ["C1", 1, "V3V3"], ["C1", 2, "GND"],
    ["C2", 1, "V3V3"], ["C2", 2, "GND"],
    ["C3", 1, "V1V1"], ["C3", 2, "GND"],
    ["TP_3V3", 1, "V3V3"],
  ] as const) {
    expect(schematicPortReachesNetLabel(circuitJson, name, pin, net)).toBe(true)
  }
}, 30_000)

test("supplier footprint resolves locally and connects the thermal pad", async () => {
  const circuitJson = await renderCircuitFile(example("supplier-footprint"))
  expect(circuitJson.filter((element) => element.type === "pcb_smtpad")).toHaveLength(59)
  expect(circuitJson.filter((element) => element.type === "pcb_trace").length).toBeGreaterThan(0)
  expect(circuitJson.filter((element) => element.type.endsWith("_error"))).toEqual([])
}, 30_000)

test("same relative module specifiers in different directories retain distinct circuits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "standalone-module-cache-"))
  try {
    await mkdir(join(dir, "a"))
    await mkdir(join(dir, "b"))
    await writeFile(join(dir, "index.tsx"), `import { A } from './a/A'; import { B } from './b/B'; export default () => <board width="20mm" height="15mm"><A/><B/></board>`)
    await writeFile(join(dir, "a/A.tsx"), `import { Shared } from './Shared'; export const A = () => <Shared name="R1" pcbX={-3} />`)
    await writeFile(join(dir, "b/B.tsx"), `import { Shared } from './Shared'; export const B = () => <Shared name="R2" pcbX={3} />`)
    await writeFile(join(dir, "a/Shared.tsx"), `export const Shared = (props: any) => <resistor {...props} resistance="1k" footprint="0603" />`)
    await writeFile(join(dir, "b/Shared.tsx"), `export const Shared = (props: any) => <resistor {...props} resistance="2k" footprint="0603" />`)
    const circuitJson = await renderCircuitFile(join(dir, "index.tsx"))
    const resistors = circuitJson.filter((element) => element.type === "source_component" && element.ftype === "simple_resistor")
    const resistanceByName = Object.fromEntries(resistors.map((element) => [element.name, "resistance" in element ? element.resistance : undefined]))
    expect(resistanceByName).toEqual({ R1: 1000, R2: 2000 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)

test("unsupported dynamic imports fail before publishing a circuit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "standalone-dynamic-"))
  try {
    await writeFile(join(dir, "index.tsx"), `let resistance = '1k'; import('./value').then((module) => { resistance = module.resistance }); export default () => <board width="10mm" height="10mm"><resistor name="R1" resistance={resistance} footprint="0603"/></board>`)
    await writeFile(join(dir, "value.ts"), `export const resistance = '4.7k'`)
    await expect(buildCircuitFile(join(dir, "index.tsx"), { outputDir: join(dir, "output") })).rejects.toThrow("Dynamic imports")
    await expect(readdir(join(dir, "output"))).rejects.toThrow("ENOENT")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)

const rejectedCircuits = [
  ["unbundled supplier", `<chip name="U1" footprint="qfn8" supplierPartNumbers={{jlcpcb:['C999999999']}}/>`, "not bundled"],
  ["unbundled manufacturer", `<chip name="U1" footprint="qfn8" manufacturerPartNumber="UNBUNDLED_CHIP"/>`, "not bundled"],
  ["unsupported supplier", `<chip name="U1" footprint="qfn8" supplierPartNumbers={{digikey:['NOT_BUNDLED']}}/>`, "Supplier"],
  ["contradictory identity", `<chip name="U1" footprint="qfn8" manufacturerPartNumber="OTHER_CHIP" supplierPartNumbers={{jlcpcb:['C2040']}}/>`, "RP2040"],
  ["remote footprint", `<chip name="U1" footprint="https://example.invalid/footprint.json"/>`, "not bundled"],
  ["remote KiCad library", `<chip name="U1" footprint="kicad:Package_QFN:QFN-8"/>`, "KiCad"],
  ["remote CAD", `<chip name="U1" footprint="qfn8" cadModel={{objUrl:'https://example.invalid/model.obj'}}/>`, "asset"],
] as const

for (const [name, body, message] of rejectedCircuits) {
  test(`${name} fails locally without publishing a partial build`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "standalone-rejected-"))
    const outputDir = join(dir, "output")
    try {
      const entry = join(dir, "index.tsx")
      await writeFile(entry, `export default () => <board width="20mm" height="20mm">${body}</board>`)
      await expect(buildCircuitFile(entry, { outputDir })).rejects.toThrow(message)
      await expect(readdir(outputDir)).rejects.toThrow("ENOENT")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
}

test("authored cloud autorouting is rejected before any output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "standalone-cloud-"))
  try {
    const entry = join(dir, "index.tsx")
    await writeFile(entry, `export default () => <board width="10mm" height="10mm" autorouter={{serverUrl:'https://example.invalid/route'}}><resistor name="R1" resistance="1k" footprint="0603"/></board>`)
    await expect(buildCircuitFile(entry, { outputDir: join(dir, "output") })).rejects.toThrow("autorouter")
    await expect(readdir(join(dir, "output"))).rejects.toThrow("ENOENT")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
