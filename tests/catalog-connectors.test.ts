import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCli } from "../cli/main"
import { renderCircuitFile } from "../lib/build"

test("normal connector imports retain USB-C source/SMT pins, D− schematic terminals and FFC/U.FL copper numbering", async () => {
  const project = await mkdtemp(join(tmpdir(), "standalone-connectors-"))
  const stderr: string[] = []
  const io = { stdout: () => {}, stderr: (message: string) => stderr.push(message) }
  try {
    await mkdir(join(project, "imports"))
    for (const part of ["C2765186", "C202112", "C88373"]) {
      expect(
        await runCli(["import", part, "--output", join(project, "imports", `${part}.tsx`)], io),
      ).toBe(0)
      expect(await readFile(join(project, "imports", `${part}.tsx`), "utf8")).not.toContain(
        "cadModel=",
      )
    }
    expect(stderr).toEqual([])
    const entry = join(project, "connectors.tsx")
    await writeFile(
      entry,
      `
import USB from "./imports/C2765186"
import FFC from "./imports/C202112"
import RF from "./imports/C88373"
export default () => <board width="80mm" height="30mm" schMaxTraceDistance={0}>
  <USB name="J_USB" pcbX={-20} schX={-15}/>
  <FFC name="J_CAM" pcbX={0} schX={0}/>
  <RF name="J_RF" pcbX={20} schX={15}/>
</board>`,
    )
    const circuit = await renderCircuitFile(entry, { projectDir: project })
    const padsFor = (name: string) => {
      const source = circuit.find(
        (element) => element.type === "source_component" && element.name === name,
      )
      if (source?.type !== "source_component") throw new Error(`Missing ${name}`)
      const pcb = circuit.find(
        (element) =>
          element.type === "pcb_component" &&
          element.source_component_id === source.source_component_id,
      )
      if (pcb?.type !== "pcb_component") throw new Error(`Missing PCB ${name}`)
      return circuit.filter(
        (element) =>
          (element.type === "pcb_smtpad" || element.type === "pcb_plated_hole") &&
          element.pcb_component_id === pcb.pcb_component_id,
      )
    }
    const pinFor = (pad: ReturnType<typeof padsFor>[number]) => {
      if (pad.type !== "pcb_smtpad" && pad.type !== "pcb_plated_hole")
        throw new Error("Expected copper")
      const port = circuit.find(
        (element) => element.type === "pcb_port" && element.pcb_port_id === pad.pcb_port_id,
      )
      if (port?.type !== "pcb_port") throw new Error("Copper lost its PCB port")
      const source = circuit.find(
        (element) =>
          element.type === "source_port" && element.source_port_id === port.source_port_id,
      )
      if (source?.type !== "source_port") throw new Error("Copper lost its source port")
      return source.pin_number
    }
    const usbSource = circuit.find(
      (element) => element.type === "source_component" && element.name === "J_USB",
    )!
    if (usbSource.type !== "source_component") throw new Error("Missing USB source")
    expect(
      circuit
        .filter(
          (element) =>
            element.type === "source_port" &&
            element.source_component_id === usbSource.source_component_id &&
            element.pin_number !== undefined,
        )
        .map((port) => (port as { pin_number: number }).pin_number)
        .sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 14 }, (_, index) => index + 13))
    const schematicPortIds = new Set(
      circuit
        .filter((element) => element.type === "schematic_port")
        .map((port) => port.source_port_id),
    )
    for (const pin of [19, 21]) {
      const source = circuit.find(
        (element) =>
          element.type === "source_port" &&
          element.source_component_id === usbSource.source_component_id &&
          element.pin_number === pin,
      )
      if (source?.type !== "source_port") throw new Error(`Missing D− pin ${pin}`)
      expect(schematicPortIds.has(source.source_port_id)).toBe(true)
    }
    // Shared shell terminals need the Core physical-port fix; full geometry and
    // numbering are independently checked against the supplier in qualification.
    const usbContacts = padsFor("J_USB").filter((pad) => pad.type === "pcb_smtpad")
    expect(usbContacts.map(pinFor).sort((a, b) => a! - b!)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 15),
    )
    const ffc = padsFor("J_CAM")
    expect(ffc.map(pinFor).sort((a, b) => a! - b!)).toEqual(
      Array.from({ length: 26 }, (_, index) => index + 1),
    )
    const contacts = ffc.filter((pad) => pinFor(pad)! <= 24)
    expect(
      pinFor(contacts.toSorted((a, b) => (a as { x: number }).x - (b as { x: number }).x)[0]!),
    ).toBe(24)
    expect(
      pinFor(contacts.toSorted((a, b) => (b as { x: number }).x - (a as { x: number }).x)[0]!),
    ).toBe(1)
    const rf = padsFor("J_RF")
    expect(rf.map(pinFor).sort((a, b) => a! - b!)).toEqual([1, 2, 3])
    const rfSignal = rf.find((pad) => pinFor(pad) === 2)!
    const ground = rf.find((pad) => pinFor(pad) === 1)!
    expect((rfSignal as { x: number }).x).toBeLessThan((ground as { x: number }).x)
    const bounds = rf.map((pad) => {
      if (pad.type !== "pcb_smtpad" || pad.shape !== "rect")
        throw new Error("Expected rectangular U.FL copper")
      return { left: pad.x - pad.width / 2, right: pad.x + pad.width / 2 }
    })
    expect(
      (Math.min(...bounds.map((bound) => bound.left)) +
        Math.max(...bounds.map((bound) => bound.right))) /
        2,
    ).toBeCloseTo(20, 6)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}, 30_000)
