import { describe, expect, test } from "bun:test"
import { bundledParts } from "../lib/bundled-parts"
import {
  BundledPartNotFoundError,
  createCatalog,
  generateBundledComponentTsx,
  getBundledFootprintCircuitJson,
  getBundledPart,
  serializeCatalog,
} from "../lib/catalog"

const rp2040 = getBundledPart("C2040")

describe("compact part catalog", () => {
  test("C2040 is the verified RP2040 with 56 signal pads and thermal ground", () => {
    const part = getBundledPart("C2040")
    expect(part.manufacturerPartNumber).toBe("RP2040")
    expect(part.provenance).toMatchObject({
      kind: "datasheet-api",
      datasheetId: "2a51fc64-5154-4513-ad7c-29429bdc973e",
    })
    const pads = getBundledFootprintCircuitJson(part).filter(
      (element) => element.type === "pcb_smtpad",
    )
    expect(pads).toHaveLength(57)
    const pinOne = pads.find((pad) => pad.port_hints?.includes("pin1"))!
    expect(pinOne.port_hints).toContain("IOVDD")
    expect(pinOne.shape).toBe("rect")
    if (pinOne.shape === "rect") {
      expect(pinOne.x).toBeCloseTo(-3.425, 5)
      expect(pinOne.y).toBeCloseTo(2.6, 5)
    }
    const thermal = pads.find((pad) => pad.port_hints?.includes("thermalpad"))!
    expect(thermal.port_hints).toContain("pin57")
    expect(thermal.port_hints).toContain("GND")
    expect(thermal.shape).toBe("rect")
    if (thermal.shape === "rect") {
      expect(thermal.x).toBe(0)
      expect(thermal.y).toBe(0)
      expect(thermal.width).toBe(3.1)
      expect(thermal.height).toBe(3.1)
    }
  })

  test("rejects duplicates, remote footprints, raw geometry and unmapped pads", () => {
    expect(() => createCatalog([rp2040, rp2040])).toThrow(
      "duplicate supplier part C2040",
    )
    expect(() =>
      createCatalog([
        { ...rp2040, footprint: "https://example.com/footprint.json" },
      ]),
    ).toThrow("local footprinter string")
    expect(() =>
      createCatalog([{ ...rp2040, footprint: "kicad:QFN-56" }]),
    ).toThrow("local footprinter string")
    expect(() =>
      createCatalog([{ ...rp2040, circuitJson: [] }]),
    ).toThrow("unsupported part field circuitJson")
    expect(() =>
      createCatalog([
        { ...rp2040, cadModel: { objUrl: "https://example.com/a.obj" } },
      ]),
    ).toThrow("unsupported part field cadModel")
    const pinLabels = { ...rp2040.pinLabels, pin57: ["GND"] }
    expect(() => createCatalog([{ ...rp2040, pinLabels }])).toThrow(
      "each copper pad must map",
    )
    expect(() =>
      createCatalog([{ ...rp2040, footprint: "notarealfootprint" }]),
    ).toThrow("cannot be generated")
  })

  test("catalog and generated source are deterministic and contain no CAD URLs", () => {
    const secondPart = {
      ...rp2040,
      supplierPartNumber: "C2041",
      componentName: "RP2040OtherSupplierRecord",
    }
    expect(serializeCatalog([secondPart, ...bundledParts])).toBe(
      serializeCatalog([...bundledParts, secondPart]),
    )
    const part = getBundledPart("C2040")
    const source = generateBundledComponentTsx(part)
    expect(source).toBe(generateBundledComponentTsx(part))
    expect(source).toContain('manufacturerPartNumber={"RP2040"}')
    expect(source).toContain('jlcpcb: ["C2040"]')
    expect(source).not.toContain("cadModel")
    expect(source).not.toContain("modelcdn")
    expect(() => getBundledPart("C999999999")).toThrow(
      BundledPartNotFoundError,
    )
  })

  test("rejects aliases to other physical pins but permits shared functional labels", () => {
    for (const alias of ["pin2", "2", "Pin2", "pin02"]) {
      const pinLabels = {
        ...rp2040.pinLabels,
        pin1: ["IOVDD6", alias],
      }
      expect(() => createCatalog([{ ...rp2040, pinLabels }])).toThrow(
        "pin1 cannot alias physical pin2",
      )
    }
    const pinLabels = {
      ...rp2040.pinLabels,
      pin1: ["IOVDD6", "GND"],
    }
    const part = getBundledPart(
      "C2040",
      createCatalog([{ ...rp2040, pinLabels }]),
    )
    const pads = getBundledFootprintCircuitJson(part).filter(
      (element) => element.type === "pcb_smtpad",
    )
    expect(pads.filter((pad) => pad.port_hints?.includes("GND"))).toHaveLength(2)
    expect(pads.filter((pad) => pad.port_hints?.includes("pin2"))).toHaveLength(1)
  })

  test("generated TSX parses when manufacturer part numbers contain quotes", () => {
    const manufacturerPartNumber = 'a"b<&'
    const part = getBundledPart(
      "C2040",
      createCatalog([{ ...rp2040, manufacturerPartNumber }]),
    )
    const source = generateBundledComponentTsx(part)
    expect(source).toContain(
      `manufacturerPartNumber={${JSON.stringify(manufacturerPartNumber)}}`,
    )
    const transpiler = new Bun.Transpiler({ loader: "tsx" })
    expect(() => transpiler.transformSync(source)).not.toThrow()
  })

  test("input mutation cannot change a validated catalog", () => {
    const input = JSON.parse(JSON.stringify([rp2040]))
    const catalog = createCatalog(input)
    input[0].pinLabels.pin1[0] = "WRONG_PIN"
    input[0].footprint = "qfn4"
    expect(getBundledPart("C2040", catalog).pinLabels.pin1).toEqual(rp2040.pinLabels.pin1)
    expect(getBundledPart("C2040", catalog).footprint).toBe(
      rp2040.footprint,
    )
  })
})
