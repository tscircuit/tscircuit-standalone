import { describe, expect, test } from "bun:test"
import { Circuit } from "@tscircuit/core"
import { createRequire } from "node:module"
import { adaptDatasheetPart } from "../lib/datasheet-catalog"
import type { DatasheetSnapshotPart } from "../lib/datasheet-snapshot-types"
import { getPadPin } from "../lib/catalog-validation"
import { getBundledFootprintCircuitJson, getBundledPart } from "../lib/catalog"
import { createStandalonePlatformConfig } from "../lib/platform"

const { createElement } = createRequire(import.meta.url)("react")

const fixture = (
  overrides: Partial<DatasheetSnapshotPart> = {},
): DatasheetSnapshotPart => ({
  datasheet_id: "11111111-1111-1111-1111-111111111111",
  chip_name: "TestChip",
  datasheet_pdf_urls: ["https://example.com/public.pdf"],
  ai_description: "",
  footprinter_string: "soic2",
  pin_information: [
    { pin_number: "1", name: ["D+"], description: "", capabilities: [] },
    { pin_number: "2", name: ["D-"], description: "", capabilities: [] },
  ],
  pin_attributes: { "D+": { isBidirectional: true }, "D-": { isInput: true } },
  ...overrides,
})

describe("datasheet facts adapted to core selectors", () => {
  test("keeps positive and negative terminals distinct and maps raw attribute keys", () => {
    const source = fixture()
    const original = JSON.stringify(source)
    const part = adaptDatasheetPart(source)
    expect(part.pinLabels).toEqual({ pin1: ["D_POS"], pin2: ["D_NEG"] })
    expect(part.pinAttributes).toEqual({
      pin1: { isBidirectional: true },
      pin2: { isInput: true },
    })
    expect(JSON.stringify(source)).toBe(original)
  })

  test("uses readable punctuation selectors without conflating existing or shared aliases", () => {
    const source = fixture({
      footprinter_string: "soic6",
      pin_information: [
        { pin_number: "1", name: ["P0.29", "GND"], description: "", capabilities: [] },
        { pin_number: "2", name: ["P0_29", "GND"], description: "", capabilities: [] },
        { pin_number: "3", name: ["DTR#"], description: "", capabilities: [] },
        { pin_number: "4", name: ["IN1+"], description: "", capabilities: [] },
        { pin_number: "5", name: ["IN1-"], description: "", capabilities: [] },
        {
          pin_number: "6",
          name: ["D_POS", "D+", "D_u2b_"],
          description: "",
          capabilities: [],
        },
      ],
      pin_attributes: {
        GND: { requiresGround: true },
        "DTR#": { isOutput: true },
        "D+": { isBidirectional: true },
      },
    })
    const original = JSON.stringify(source)
    const part = adaptDatasheetPart(source)
    expect(part.pinLabels.pin1).toEqual(["P0_u2e_29", "GND"])
    expect(part.pinLabels.pin2).toEqual(["P0_29", "GND"])
    expect(part.pinLabels.pin3).toEqual(["DTR_N"])
    expect(part.pinLabels.pin4).toEqual(["IN1_POS"])
    expect(part.pinLabels.pin5).toEqual(["IN1_NEG"])
    expect(part.pinLabels.pin6).toEqual(["D_POS", "D_u2b__", "D_u2b_"])
    expect(part.pinAttributes).toEqual({
      pin1: { requiresGround: true },
      pin2: { requiresGround: true },
      pin3: { isOutput: true },
      pin6: { isBidirectional: true },
    })
    expect(
      Object.values(part.pinLabels)
        .flat()
        .every((name) => /^[A-Za-z0-9_]+$/.test(name)),
    ).toBe(true)
    expect(JSON.stringify(source)).toBe(original)
  })

  test("retains numeric package IDs and gives named exposed pads a separate core pin", () => {
    const source = fixture({
      footprinter_string: "qfn8_thermalpad1.6x1.6mm",
      pin_information: [
        ...Array.from({ length: 8 }, (_, i) => ({
          pin_number: String(i + 1),
          name: [`IO${i + 1}`],
          description: "",
          capabilities: [],
        })),
        {
          pin_number: "EP",
          name: ["GND", "thermalpad"],
          description: "",
          capabilities: [],
        },
      ],
      pin_attributes: {
        EP: { requiresGround: true },
        pin8: { requiresVoltage: "3.3V", requiredVoltageTolerance: "5%" },
      },
    })
    const part = adaptDatasheetPart(source)
    expect(part.pinLabels.pin8).toEqual(["IO8"])
    expect(part.pinLabels.pin9).toEqual(["EP", "GND", "thermalpad"])
    expect(part.pinAttributes?.pin9).toEqual({ requiresGround: true })
    expect(part.pinAttributes?.pin8).toEqual({
      requiresVoltage: "3.3V",
      requiredVoltageTolerance: "5%",
    })
  })

  test("retains ball coordinates and source attributes on the corresponding core ports", () => {
    const source = fixture({
      footprinter_string: "bga4_grid2x2",
      pin_information: [
        { pin_number: "B2", name: ["GND"], description: "", capabilities: [] },
        { pin_number: "B1", name: ["SDA"], description: "", capabilities: [] },
        { pin_number: "A2", name: ["GND"], description: "", capabilities: [] },
        { pin_number: "A1", name: ["VCC"], description: "", capabilities: [] },
      ],
      pin_attributes: {
        A1: { requiresVoltage: "3.3V" },
        pinB1: { isBidirectional: true },
      },
    })
    const part = adaptDatasheetPart(source)
    expect(part.pinLabels.pin1).toEqual(["A1", "VCC"])
    expect(part.pinLabels.pin3).toEqual(["B1", "SDA"])
    expect(part.pinAttributes?.pin1).toEqual({ requiresVoltage: "3.3V" })
    expect(part.pinAttributes?.pin3).toEqual({ isBidirectional: true })
  })

  test("BGA rows AA and AB retain Footprinter ordinals and physical ownership during rendering", async () => {
    const rows = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "AA", "AB"]
    const source = fixture({
      footprinter_string: "bga28_grid1x28",
      pin_information: rows
        .toReversed()
        .map((row) => ({
          pin_number: `${row}1`,
          name: ["GND"],
          description: "",
          capabilities: [],
        })),
      pin_attributes: { AA1: { requiresGround: true }, A1: { isInput: true } },
    })
    const part = adaptDatasheetPart(source)
    expect(part.pinLabels.pin2).toEqual(["B1", "GND"])
    expect(part.pinLabels.pin27).toEqual(["AA1", "GND"])
    expect(part.pinLabels.pin28).toEqual(["AB1", "GND"])
    expect(part.pinAttributes?.pin27).toEqual({ requiresGround: true })
    expect(getPadPin(["27", "AA1"], part.pinLabels)).toBe("pin27")
    const circuit = new Circuit({ platform: createStandalonePlatformConfig() })
    circuit.add(
      createElement(
        "board",
        { width: "50mm", height: "50mm", routingDisabled: true },
        createElement("chip", {
          name: "U1",
          footprint: part.footprint,
          pinLabels: part.pinLabels,
          pinAttributes: part.pinAttributes,
        }),
      ),
    )
    await circuit.renderUntilSettled()
    const json = circuit.getCircuitJson()
    const pad = json.find(
      (element) => element.type === "pcb_smtpad" && element.port_hints?.includes("AA1"),
    )
    expect(pad?.type).toBe("pcb_smtpad")
    if (pad?.type !== "pcb_smtpad") throw new Error("AA1 copper contact missing")
    const pcbPort = json.find(
      (element) =>
        element.type === "pcb_port" && element.pcb_port_id === pad.pcb_port_id,
    )
    if (pcbPort?.type !== "pcb_port") throw new Error("AA1 PCB port missing")
    const sourcePort = json.find(
      (element) =>
        element.type === "source_port" &&
        element.source_port_id === pcbPort.source_port_id,
    )
    expect(sourcePort).toMatchObject({
      pin_number: 27,
      name: "AA1",
      requires_ground: true,
    })
  })
})

for (const name of ["nRF52840-QIAA", "SX1262IMLTRT", "OV2640"]) {
  test(`core renders ${name} with every physical terminal and pin attribute bound`, async () => {
    const part = getBundledPart(name)
    const circuit = new Circuit({ platform: createStandalonePlatformConfig() })
    circuit.add(
      createElement(
        "board",
        { width: "50mm", height: "50mm", routingDisabled: true },
        createElement("chip", {
          name: "U1",
          footprint: part.footprint,
          pinLabels: part.pinLabels,
          pinAttributes: part.pinAttributes,
        }),
      ),
    )
    await circuit.renderUntilSettled()
    const json = circuit.getCircuitJson()
    const sourcePorts = json.filter((element) => element.type === "source_port")
    const pads = json.filter(
      (element) => element.type === "pcb_smtpad" || element.type === "pcb_plated_hole",
    )
    const expectedPads = getBundledFootprintCircuitJson(part).filter(
      (element) => element.type === "pcb_smtpad" || element.type === "pcb_plated_hole",
    )
    expect(sourcePorts).toHaveLength(Object.keys(part.pinLabels).length)
    expect(pads).toHaveLength(expectedPads.length)
    expect(pads.every((pad) => Boolean(pad.pcb_port_id))).toBe(true)
    expect(
      json.filter(
        (element) => element.type === "source_failed_to_create_component_error",
      ),
    ).toEqual([])
    expect(
      json.filter(
        (element) =>
          element.type === "source_property_ignored_warning" &&
          element.property_name?.startsWith("pinLabels"),
      ),
    ).toEqual([])
    for (const [key, attributes] of Object.entries(part.pinAttributes ?? {})) {
      const port = sourcePorts.find((port) => port.pin_number === Number(key.slice(3)))
      expect(port).toBeDefined()
      if (attributes.requiresGround !== undefined)
        expect(port?.requires_ground).toBe(attributes.requiresGround)
      if (attributes.isGpio !== undefined) expect(port?.is_gpio).toBe(attributes.isGpio)
      if (attributes.isInput !== undefined)
        expect(port?.is_input).toBe(attributes.isInput)
      if (attributes.mustBeConnected !== undefined)
        expect(port?.must_be_connected).toBe(attributes.mustBeConnected)
    }
    if (name === "nRF52840-QIAA")
      expect(
        sourcePorts.some((port) =>
          [port.name, ...(port.port_hints ?? [])].includes("P0_29"),
        ),
      ).toBe(true)
    if (name === "SX1262IMLTRT")
      expect(sourcePorts.find((port) => port.pin_number === 0)?.requires_ground).toBe(
        true,
      )
  })
}
