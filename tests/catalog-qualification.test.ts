import { expect, test } from "bun:test"
import { getBundledFootprintCircuitJson, getBundledPart } from "../lib/catalog"
import { qualifyPartReference } from "../scripts/qualify-catalog"

test("qualification catches missing copper, swapped physical pins and an inaccurate recipe", () => {
  const part = getBundledPart("C2040")
  const reference = getBundledFootprintCircuitJson(part)
  const accepted = qualifyPartReference(part, reference)
  expect(accepted.sourcePadCount).toBe(57)
  expect(accepted.pinsMatch).toBe(true)
  expect(accepted.copperIntersectionOverUnion).toBeCloseTo(1, 5)
  const firstPad = reference.findIndex((element) => element.type === "pcb_smtpad")
  expect(() =>
    qualifyPartReference(
      part,
      reference.filter((_, index) => index !== firstPad),
    ),
  ).toThrow("pad counts differ")
  const swapped = structuredClone(reference)
  const pad1 = swapped.find(
    (element) => element.type === "pcb_smtpad" && element.port_hints?.includes("pin1"),
  )!
  const pad2 = swapped.find(
    (element) => element.type === "pcb_smtpad" && element.port_hints?.includes("pin2"),
  )!
  if (pad1.type !== "pcb_smtpad" || pad2.type !== "pcb_smtpad") throw new Error("Expected SMT pads")
  ;[pad1.port_hints, pad2.port_hints] = [pad2.port_hints, pad1.port_hints]
  expect(() => qualifyPartReference(part, swapped)).toThrow("physical pin mapping differs")
  expect(() =>
    qualifyPartReference(
      { ...part, footprint: part.footprint.replace("pw0.2mm", "pw0.1mm") },
      reference,
    ),
  ).toThrow("copper IoU")
})
