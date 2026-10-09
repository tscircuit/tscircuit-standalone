import { afterEach, describe, expect, mock, test } from "bun:test"
import type { AnySourceComponent } from "circuit-json"
import {
  createStandaloneFetch,
  createStandalonePlatformConfig,
  OfflineRequestError,
} from "../lib/platform"

const nativeFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = nativeFetch
})

describe("standalone platform", () => {
  test("embedded fetch responses and supplier resolver never call native fetch", async () => {
    const network = mock(() => {
      throw new Error("Unexpected network request")
    })
    globalThis.fetch = network as unknown as typeof fetch
    const platform = createStandalonePlatformConfig()
    const response = await platform.platformFetch!(
      "standalone://parts/C2040/component.tsx",
    )
    expect(response.ok).toBe(true)
    expect(await response.text()).toContain('manufacturerPartNumber={"RP2040"}')
    const footprint = await platform.platformFetch!(
      new Request("standalone://parts/C2040/footprint.json"),
    )
    const pads = (await footprint.json()).filter(
      (element: { type: string }) => element.type === "pcb_smtpad",
    )
    expect(pads).toHaveLength(57)
    const libraryResolver = platform.footprintLibraryMap!.jlcpcb
    if (typeof libraryResolver !== "function") throw new Error("Missing resolver")
    const resolved = await libraryResolver("C2040")
    expect(resolved.footprintCircuitJson).toHaveLength(65)
    expect(resolved.cadModel).toBeUndefined()
    const supplierFootprint = await platform.partsEngine!.fetchPartCircuitJson!({
      supplierPartNumber: "C2040",
    })
    expect(supplierFootprint).toHaveLength(65)
    expect(await platform.partsEngine!.fetchPartAvailability!({
      supplierName: "jlcpcb",
      supplierPartNumber: "C2040",
    })).toBeUndefined()
    expect(network).not.toHaveBeenCalled()
  })

  test("missing resources, remote hosts and unsupported methods fail without fallback", async () => {
    const network = mock(() => {
      throw new Error("Unexpected network request")
    })
    globalThis.fetch = network as unknown as typeof fetch
    const fetch = createStandaloneFetch()
    await expect(fetch("https://jlcsearch.tscircuit.com/api/search?q=RP2040"))
      .rejects.toBeInstanceOf(OfflineRequestError)
    await expect(fetch("standalone://parts/C999999999/component.tsx"))
      .rejects.toThrow("not bundled")
    await expect(fetch("standalone://parts/C2040/missing.json"))
      .rejects.toBeInstanceOf(OfflineRequestError)
    await expect(fetch("standalone://parts/C2040/metadata.json", { method: "POST" }))
      .rejects.toBeInstanceOf(OfflineRequestError)
    await expect(fetch("standalone://parts/C2040/metadata.json?remote=true"))
      .rejects.toBeInstanceOf(OfflineRequestError)
    const head = await fetch("standalone://parts/C2040/metadata.json", {
      method: "HEAD",
    })
    expect(head.ok).toBe(true)
    expect(await head.text()).toBe("")
    expect(() => fetch.preconnect("https://example.com"))
      .toThrow(OfflineRequestError)
    expect(network).not.toHaveBeenCalled()
  })

  test("resolves declared supplier or MPN using local catalog and disables cloud defaults", async () => {
    const platform = createStandalonePlatformConfig()
    const supplierComponent = {
      type: "source_component",
      source_component_id: "source_component_0",
      ftype: "simple_chip",
      name: "U1",
      supplier_part_numbers: { jlcpcb: ["C2040"] },
    } as AnySourceComponent
    expect(
      await platform.partsEngine!.findPart({ sourceComponent: supplierComponent }),
    ).toEqual({ jlcpcb: ["C2040"] })
    expect(
      await platform.partsEngine!.findPart({
        sourceComponent: {
          ...supplierComponent,
          supplier_part_numbers: undefined,
          manufacturer_part_number: "RP2040",
        } as AnySourceComponent,
      }),
    ).toEqual({ jlcpcb: ["C2040"] })
    expect(() => platform.partsEngine!.fetchPartCircuitJson!({
      supplierPartNumber: "C999999999",
    })).toThrow("not bundled")
    expect(platform.checkAvailability).toBe(false)
    expect(platform.useCloudAutorouter).toBe(false)
    expect(platform.allowLegacyAutorouters).toBe(false)
    expect(platform.analogSimulationDisabled).toBe(true)
    expect(platform.partsEngineDisabled).not.toBe(true)
  })
})
