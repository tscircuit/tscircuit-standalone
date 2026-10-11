import { afterEach, describe, expect, test } from "bun:test"
import { gunzipSync, strFromU8 } from "fflate"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { adaptDatasheetPart } from "../lib/datasheet-catalog"
import type { DatasheetSnapshotPart } from "../lib/datasheet-snapshot-types"
import {
  buildDatasheetCatalog,
  writeBundledPartsModule,
} from "../scripts/build-datasheets"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

const directory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "standalone-datasheet-build-"))
  directories.push(path)
  return path
}

const uuid = (name: string): string => {
  const hex = createHash("sha256").update(name).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

const part = (
  id: string,
  name: string,
): DatasheetSnapshotPart & { generated_tsx: string } => ({
  datasheet_id: uuid(id),
  chip_name: name,
  datasheet_pdf_urls: ["https://example.com/public.pdf"],
  pin_information: [
    {
      pin_number: "1",
      name: ["VCC"],
      description: "Raw supply description",
      capabilities: ["power"],
    },
    {
      pin_number: "2",
      name: ["GND"],
      description: "Raw ground description",
      capabilities: ["ground"],
    },
  ],
  ai_description: "Raw component description should not be embedded",
  pin_attributes: { pin1: { requiresPower: true }, pin2: { requiresGround: true } },
  footprinter_string: "soic2",
  generated_tsx:
    "fetch('https://example.com/do-not-embed'); export const Chip = () => null",
})

const api = (
  records: Array<{ datasheet_id: string; chip_name: string }>,
  options: {
    details?: (id: string) => Response
    finalList?: Array<{ datasheet_id: string; chip_name: string }>
    onGet?: () => void
  } = {},
): typeof fetch => {
  let lists = 0
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/datasheets/list")) {
      lists++
      const entries =
        lists > 1 && options.finalList ? options.finalList : records
      return Response.json({
        datasheets: entries.map(({ datasheet_id, chip_name }) => ({
          datasheet_id,
          chip_name,
        })),
      })
    }
    expect(String(input).endsWith("/datasheets/get")).toBe(true)
    expect(init?.method).toBe("POST")
    const id = JSON.parse(String(init?.body)).datasheet_id as string
    options.onGet?.()
    return (
      options.details?.(id) ??
      Response.json({
        datasheet: records.find((entry) => entry.datasheet_id === id),
      })
    )
  }) as unknown as typeof fetch
}

const silent = (_message: string): void => {}
const defaults = { outputPath: false as const, log: silent }

const previousModule = async (outputPath: string): Promise<void> => {
  await writeFile(outputPath, "previous module\n")
}
const expectUnchanged = async (outputPath: string): Promise<void> => {
  expect(await readFile(outputPath, "utf8")).toBe("previous module\n")
}

describe("build-time datasheet compilation", () => {
  test("embeds only compiled parts and public provenance, omitting raw records and generated source", async () => {
    const outputPath = join(await directory(), "generated-bundled-parts.ts")
    const source = part("a", "ReviewedChip")
    const logs: string[] = []
    const result = await buildDatasheetCatalog({
      fetch: api([source]),
      outputPath,
      log: (message) => logs.push(message),
    })
    const { bundledPartsGzipBase64 } = await import(outputPath)
    const compressed = Buffer.from(bundledPartsGzipBase64, "base64")
    const decoded = strFromU8(gunzipSync(compressed))
    expect(JSON.parse(decoded)).toEqual(result.parts)
    expect(result.parts).toEqual([adaptDatasheetPart(source)])
    expect(result.parts[0]!.provenance).toEqual({
      kind: "datasheet-api",
      datasheetId: source.datasheet_id,
      datasheetUrls: source.datasheet_pdf_urls,
    })
    for (const omitted of [
      "generated_tsx",
      "do-not-embed",
      "pin_information",
      "ai_description",
      "Raw component description",
      "Raw supply description",
    ]) {
      expect(decoded).not.toContain(omitted)
    }
    expect(result.gzipBytes).toBe(compressed.length)
    expect(result.jsonBytes).toBe(Buffer.byteLength(decoded))
    expect(await readFile(outputPath, "utf8")).toBe(result.moduleText)
    expect(logs[0]).toContain("Bundled 1 of 1 datasheets")
    expect(logs[0]).toContain("compressed")
  })

  test("preserves the C2040 compatibility lookup when compiling RP2040", async () => {
    const result = await buildDatasheetCatalog({
      ...defaults,
      fetch: api([part("rp", "RP2040")]),
    })
    expect(result.parts[0]!.supplierPartNumber).toBe("C2040")
    expect(result.parts[0]!.manufacturerPartNumber).toBe("RP2040")
  })

  test("compiles coordinate pins and attributes into numeric Core ports while preserving package aliases", async () => {
    const source = {
      ...part("bga", "CoordinatePart"),
      footprinter_string: "bga4_pinnumbering(ballcoords)",
      pin_information: [
        { pin_number: "B2", name: ["GND"], description: "", capabilities: [] },
        { pin_number: "A1", name: ["VCC"], description: "", capabilities: [] },
        { pin_number: "B1", name: ["SDA"], description: "", capabilities: [] },
        { pin_number: "A2", name: ["SCL"], description: "", capabilities: [] },
      ],
      pin_attributes: {
        A1: { requiresPower: true },
        B2: { requiresGround: true },
        SDA: { isInput: true, isOutput: true },
      },
    }
    const result = await buildDatasheetCatalog({
      ...defaults,
      fetch: api([source]),
    })
    expect(result.parts[0]!.pinLabels).toEqual({
      pin1: ["A1", "VCC"],
      pin2: ["A2", "SCL"],
      pin3: ["B1", "SDA"],
      pin4: ["B2", "GND"],
    })
    expect(result.parts[0]!.pinAttributes).toEqual({
      pin1: { requiresPower: true },
      pin4: { requiresGround: true },
      pin3: { isInput: true, isOutput: true },
    })
  })

  test("inspects every record, skips missing or nonstandard footprints, and reports exclusions", async () => {
    const records = [
      part("valid", "ValidChip"),
      { ...part("null", "NoFootprint"), footprinter_string: null },
      { ...part("attributes", "NoAttributes"), pin_attributes: null },
      {
        ...part("remote", "RemoteFootprint"),
        footprinter_string: "https://example.com/pads.json",
      },
      {
        ...part("coordinates", "RawPads"),
        footprinter_string: "padlayout_anything",
      },
      {
        ...part("profile", "ManufacturerProfile"),
        footprinter_string: "lga8_profile(adxl362)",
      },
      {
        ...part("unsupported", "UnknownPackage"),
        footprinter_string: "unknown10",
      },
    ]
    let getCount = 0
    const result = await buildDatasheetCatalog({
      ...defaults,
      fetch: api(records, { onGet: () => getCount++ }),
    })
    expect(getCount).toBe(records.length)
    expect(result.parts.map((entry) => entry.manufacturerPartNumber)).toEqual([
      "ValidChip",
    ])
    expect(result.exclusionCounts).toEqual({
      missing_footprint: 1,
      missing_pin_attributes: 1,
      nonlocal_or_malformed_footprint: 1,
      nonstandard_footprint: 2,
      unsupported_part: 1,
    })
    expect(result.includedCount + result.excludedCount).toBe(records.length)
  })

  test("validates injected compilation results before admitting them", async () => {
    const result = await buildDatasheetCatalog({
      ...defaults,
      fetch: api([part("a", "ValidChip"), part("b", "InvalidCompiledPart")]),
      compile: (source) => ({
        ...adaptDatasheetPart(source),
        ...(source.chip_name === "InvalidCompiledPart"
          ? { footprint: "https://example.com/remote.json" }
          : {}),
      }),
    })
    expect(result.parts.map((entry) => entry.manufacturerPartNumber)).toEqual([
      "ValidChip",
    ])
    expect(result.exclusions[0]!.detail).toContain("local footprinter string")
  })

  test("produces identical compressed output for reordered inventories, pin rows, and nested keys", async () => {
    const first = part("a", "AlphaChip")
    const second = part("b", "BetaChip")
    const reordered = {
      ...first,
      pin_information: first.pin_information.toReversed(),
      pin_attributes: {
        pin2: { requiresGround: true },
        pin1: { requiresPower: true },
      },
    }
    const left = await buildDatasheetCatalog({
      ...defaults,
      fetch: api([first, second]),
      concurrency: 1,
    })
    const right = await buildDatasheetCatalog({
      ...defaults,
      fetch: api([second, reordered]),
      concurrency: 8,
    })
    expect(right.moduleText).toBe(left.moduleText)
    expect(right.exclusions).toEqual(left.exclusions)
  })

  test("rejects duplicate list IDs before fetching details or replacing the prior module", async () => {
    const outputPath = join(await directory(), "generated-bundled-parts.ts")
    await previousModule(outputPath)
    let count = 0
    await expect(
      buildDatasheetCatalog({
        fetch: api([part("same", "First"), part("same", "Second")], {
          onGet: () => count++,
        }),
        outputPath,
        log: silent,
      }),
    ).rejects.toThrow("duplicate datasheet_id")
    expect(count).toBe(0)
    await expectUnchanged(outputPath)
  })

  test("rejects duplicate manufacturer names and normalized runtime lookup collisions", async () => {
    await expect(
      buildDatasheetCatalog({
        ...defaults,
        fetch: api([part("a", "Chip"), part("b", "CHIP")]),
      }),
    ).rejects.toThrow("duplicate chip_name")
    await expect(
      buildDatasheetCatalog({
        ...defaults,
        fetch: api([part("a", "Chip.A"), part("b", "ChipA")]),
      }),
    ).rejects.toThrow("normalized manufacturer name")
  })

  test("preserves the previous generated module if the final rename fails", async () => {
    const outputPath = join(await directory(), "generated-bundled-parts.ts")
    await previousModule(outputPath)
    await expect(
      writeBundledPartsModule(outputPath, "new module", async () => {
        throw new Error("Simulated rename failure")
      }),
    ).rejects.toThrow("rename failure")
    await expectUnchanged(outputPath)
  })

  test("transport failures preserve the previously generated module", async () => {
    const outputPath = join(await directory(), "generated-bundled-parts.ts")
    await previousModule(outputPath)
    await expect(
      buildDatasheetCatalog({
        fetch: api([part("a", "First"), part("b", "Second")], {
          details: (id) =>
            id === uuid("b")
              ? new Response("upstream unavailable", { status: 503 })
              : Response.json({ datasheet: part("a", "First") }),
        }),
        outputPath,
        log: silent,
      }),
    ).rejects.toThrow("HTTP 503")
    await expectUnchanged(outputPath)
  })

  test("excludes invalid per-part metadata but rejects mismatched detail identities", async () => {
    const bad = {
      ...part("b", "BadMetadata"),
      pin_information: [
        {
          pin_number: "1",
          name: "UnsafeName",
          description: "",
          capabilities: [],
        },
      ],
    }
    const result = await buildDatasheetCatalog({
      ...defaults,
      fetch: api([part("a", "First"), bad]),
    })
    expect(result.parts.map((entry) => entry.manufacturerPartNumber)).toEqual([
      "First",
    ])
    expect(result.exclusions).toEqual([
      {
        datasheet_id: uuid("b"),
        chip_name: "BadMetadata",
        reason: "invalid_metadata",
        detail: "Datasheet build failed: pin name must be an array",
      },
    ])
    await expect(
      buildDatasheetCatalog({
        ...defaults,
        fetch: api([part("a", "First")], {
          details: () =>
            Response.json({ datasheet: part("different", "First") }),
        }),
      }),
    ).rejects.toThrow("detail identity")
  })

  test("rejects changing API inventories before replacing the prior module", async () => {
    const outputPath = join(await directory(), "generated-bundled-parts.ts")
    await previousModule(outputPath)
    await expect(
      buildDatasheetCatalog({
        fetch: api([part("a", "First")], {
          finalList: [part("a", "First"), part("b", "NewChip")],
        }),
        outputPath,
        log: silent,
      }),
    ).rejects.toThrow("inventory changed")
    await expectUnchanged(outputPath)
  })

  test("rejects unknown pagination metadata rather than assuming list completeness", async () => {
    await expect(
      buildDatasheetCatalog({
        ...defaults,
        fetch: (async () =>
          Response.json({
            datasheets: [{ datasheet_id: uuid("a"), chip_name: "First" }],
            has_more: true,
          })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("pagination metadata")
  })

  test("bounds request duration even if an injected transport ignores abort", async () => {
    await expect(
      buildDatasheetCatalog({
        ...defaults,
        fetch: (() =>
          new Promise<Response>(() => {})) as unknown as typeof fetch,
        requestTimeoutMs: 15,
      }),
    ).rejects.toThrow("request deadline exceeded")
  })
})
