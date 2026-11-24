import { expect, test } from "bun:test"
import { adaptDatasheetPart } from "../lib/datasheet-catalog"
import type { DatasheetSnapshotPart } from "../lib/datasheet-snapshot-types"

const makeSnapshot = (pinOrder: string[]): DatasheetSnapshotPart => ({
  datasheet_id: "12345678-1234-1234-1234-123456789abc",
  chip_name: "TESTCHIP",
  datasheet_pdf_urls: ["https://example.com/x.pdf"],
  pin_information: pinOrder.map((pin) => ({
    pin_number: pin,
    name: [`SIG_${pin}`],
    description: "",
    capabilities: [],
  })),
  ai_description: "",
  pin_attributes: {},
  footprinter_string: "soic8",
})

const assignmentFor = (pinOrder: string[]) => {
  const part = adaptDatasheetPart(makeSnapshot(pinOrder))
  // Map each physical terminal to its assigned logical pin key, order-free.
  const assignment = new Map<string, string>()
  for (const [key, aliases] of Object.entries(part.pinLabels)) {
    for (const alias of aliases) {
      const physical = alias.replace(/^SIG_/, "")
      if (pinOrder.includes(physical)) assignment.set(physical, key)
    }
  }
  return assignment
}

test("pin numbering does not depend on the datasheet pin ordering", () => {
  // Coordinate-style pins mixed with named pins. The comparator must be a
  // total order; otherwise the sorted result depends on the input order.
  const pins = ["A1", "B2", "AB1", "B", "NC", "EP1x", "A10", "Z3"]
  const reference = assignmentFor(pins)
  const reversed = assignmentFor([...pins].reverse())
  const shuffled = assignmentFor(["AB1", "B", "A1", "NC", "B2", "EP1x", "A10", "Z3"])
  expect(reversed).toEqual(reference)
  expect(shuffled).toEqual(reference)
})

test("coordinate pins sort row-major with numeric columns", () => {
  const pins = ["B2", "A10", "A2", "B1", "A1", "AA1", "B10", "C1"]
  const part = adaptDatasheetPart(makeSnapshot(pins))
  // Row-major order: A1, A2, A10, B1, B2, B10, C1, AA1 (A=1, B=2, C=3, AA=27)
  const order = pins.map(
    (pin) => Number(assignmentFor(pins).get(pin)!.slice(3)),
  )
  const sortedRows = ["A1", "A2", "A10", "B1", "B2", "B10", "C1", "AA1"]
  for (let index = 0; index < sortedRows.length; index++) {
    expect(assignmentFor(pins).get(sortedRows[index]!)).toBe(`pin${index + 1}`)
  }
  expect(order.length).toBe(pins.length)
})
