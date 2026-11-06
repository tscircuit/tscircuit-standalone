import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copySearchCatalogs } from "../scripts/build-search-catalogs"
import { startFakePartsServices } from "../lib/fake-parts-services"

test("standalone serves provider-compatible APIs and baked assets over HTTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "fake-parts-services-"))
  await copySearchCatalogs(root)
  await mkdir(join(root, "datasheet-api/datasheets"), { recursive: true })
  await writeFile(
    join(root, "datasheet-api/datasheets/list"),
    JSON.stringify({
      datasheets: [{ chip_name: "TPS63001", datasheet_id: "tps" }],
    }),
  )
  const services = await startFakePartsServices(root)
  const upstreamFetch = globalThis.fetch
  const origin = services.env.TSCIRCUIT_BAKED_ASSET_SERVER_BASE_URL
  const localFetch = (input: string, init?: RequestInit) => {
    expect(new URL(input).origin).toBe(origin)
    return upstreamFetch(input, init)
  }
  try {
    for (const key of [
      "TSCIRCUIT_TI_BASE_URL",
      "TSCIRCUIT_DIGIKEY_BASE_URL",
      "TSCIRCUIT_MOUSER_BASE_URL",
    ] as const) {
      for (const query of ["TPS63001", "MSPM0G3507"]) {
        const response = await localFetch(
          `${services.env[key]}/api/search?q=${query}&limit=10`,
        )
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(
          body.components.some((row: { mfr: string }) =>
            row.mfr.startsWith(query),
          ),
        ).toBe(true)
        expect(body.catalog.coverage).toBe("subset")
      }
    }
    const jlc = `${services.env.TSCIRCUIT_JLCSEARCH_BASE_URL}/api/search`
    const form = await localFetch(jlc, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "q=C14663&limit=10",
    })
    expect((await form.json()).components[0].lcsc).toBe(14663)
    expect(
      (await (await localFetch(`${jlc}?q=not-a-real-part`)).json()).components,
    ).toEqual([])
    expect((await localFetch(`${jlc}?limit=-1`)).status).toBe(400)
    expect(
      await (await localFetch(`${jlc}?q=C14663`, { method: "HEAD" })).text(),
    ).toBe("")
    const registry = `${services.env.TSCIRCUIT_REGISTRY_API_URL}/packages/search`
    const response = await localFetch(registry, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "MSPM0G3507" }),
    })
    expect((await response.json()).packages.length).toBeGreaterThan(0)
    expect(
      (
        await localFetch(registry, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "bad json",
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await (
          await localFetch(
            `${services.env.TSCIRCUIT_KICAD_BASE_URL}/kicad_files.json`,
          )
        ).json()
      ).length,
    ).toBe(15428)
    expect(
      (
        await (
          await localFetch(
            `${services.env.TSCIRCUIT_DATASHEET_API_BASE_URL}/datasheets/list`,
          )
        ).json()
      ).datasheets[0].chip_name,
    ).toBe("TPS63001")
    expect((await localFetch(`${origin}/missing`)).status).toBe(404)
    expect((await localFetch(registry, { method: "OPTIONS" })).status).toBe(204)
  } finally {
    await services.stop()
    await rm(root, { recursive: true, force: true })
  }
  await expect(
    upstreamFetch(`${origin}/ti/api/search?q=TPS63001`),
  ).rejects.toThrow()
})
