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

describe("compact part catalog", () => {
  test("C2040 is the verified RP2040 with 56 signal pads and thermal ground", () => {
    const part = getBundledPart("C2040")
    expect(part.manufacturerPartNumber).toBe("RP2040")
    expect("commit" in part.provenance ? part.provenance.commit : undefined).toBe(
      "a5797da88ec19944442d87392174af0a36fe1a0a",
    )
    const pads = getBundledFootprintCircuitJson(part).filter(
      (element) => element.type === "pcb_smtpad",
    )
    expect(pads).toHaveLength(57)
    const pinOne = pads.find((pad) => pad.port_hints?.includes("pin1"))!
    expect(pinOne.port_hints).toContain("IOVDD6")
    expect(pinOne.shape).toBe("rect")
    if (pinOne.shape === "rect") {
      expect(pinOne.x).toBeCloseTo(-3.42495, 5)
      expect(pinOne.y).toBeCloseTo(2.60065, 5)
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
    expect(() => createCatalog([bundledParts[0], bundledParts[0]])).toThrow(
      "duplicate supplier part C2040",
    )
    expect(() =>
      createCatalog([{ ...bundledParts[0], footprint: "https://example.com/footprint.json" }]),
    ).toThrow("local footprinter string")
    expect(() => createCatalog([{ ...bundledParts[0], footprint: "kicad:QFN-56" }])).toThrow(
      "local footprinter string",
    )
    expect(() => createCatalog([{ ...bundledParts[0], circuitJson: [] }])).toThrow(
      "unsupported part field circuitJson",
    )
    expect(() =>
      createCatalog([{ ...bundledParts[0], cadModel: { objUrl: "https://example.com/a.obj" } }]),
    ).toThrow("unsupported part field cadModel")
    const pinLabels = { ...bundledParts[0].pinLabels, pin57: ["GND"] }
    expect(() => createCatalog([{ ...bundledParts[0], pinLabels }])).toThrow(
      "each copper pad must map",
    )
    expect(() => createCatalog([{ ...bundledParts[0], footprint: "notarealfootprint" }])).toThrow(
      "cannot be generated",
    )
  })

  test("catalog and generated source are deterministic and contain no CAD URLs", () => {
    const secondPart = {
      ...bundledParts[0],
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
    expect(() => getBundledPart("C999999999")).toThrow(BundledPartNotFoundError)
  })

  test("rejects aliases to other physical pins but permits shared functional labels", () => {
    for (const alias of ["pin2", "2", "Pin2", "pin02"]) {
      const pinLabels = {
        ...bundledParts[0].pinLabels,
        pin1: ["IOVDD6", alias],
      }
      expect(() => createCatalog([{ ...bundledParts[0], pinLabels }])).toThrow(
        "pin1 cannot alias physical pin2",
      )
    }
    const pinLabels = {
      ...bundledParts[0].pinLabels,
      pin1: ["IOVDD6", "GND"],
    }
    const part = getBundledPart("C2040", createCatalog([{ ...bundledParts[0], pinLabels }]))
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
      createCatalog([{ ...bundledParts[0], manufacturerPartNumber }]),
    )
    const source = generateBundledComponentTsx(part)
    expect(source).toContain(`manufacturerPartNumber={${JSON.stringify(manufacturerPartNumber)}}`)
    const transpiler = new Bun.Transpiler({ loader: "tsx" })
    expect(() => transpiler.transformSync(source)).not.toThrow()
  })

  test("input mutation cannot change a validated catalog", () => {
    const input = JSON.parse(JSON.stringify(bundledParts))
    const catalog = createCatalog(input)
    input[0].pinLabels.pin1[0] = "WRONG_PIN"
    input[0].footprint = "qfn4"
    expect(getBundledPart("C2040", catalog).pinLabels.pin1).toEqual(["IOVDD6"])
    expect(getBundledPart("C2040", catalog).footprint).toBe(bundledParts[0].footprint)
  })

  test("manufacturer provenance remains honest and cannot inject generated source comments", () => {
    const provenance = {
      kind: "manufacturer-facts",
      datasheetUrl: "https://www.espressif.com/esp32-s3.pdf",
      referenceUrl: "https://jlcpcb.com/partdetail/C2040",
    }
    const part = getBundledPart("C2040", createCatalog([{ ...bundledParts[0], provenance }]))
    expect(generateBundledComponentTsx(part)).toContain("Independently authored")
    expect(generateBundledComponentTsx(part)).not.toContain("Adapted from")
    for (const invalid of [
      { ...provenance, license: "MIT" },
      { ...provenance, referenceUrl: "https://example.com/\nthrow new Error()" },
      { ...provenance, referenceUrl: "https://example.com/\u0000" },
      { ...provenance, datasheetUrl: "http://example.com/datasheet.pdf" },
      { ...provenance, datasheetUrl: "https://user:secret@example.com/datasheet.pdf" },
      { ...provenance, kind: "unverified" },
      { ...bundledParts[0].provenance, unknown: true },
    ]) {
      expect(() => createCatalog([{ ...bundledParts[0], provenance: invalid }])).toThrow(
        "Invalid standalone catalog",
      )
    }
  })
})
