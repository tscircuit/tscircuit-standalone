import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { selectDynamicModules, localizeAssetUrls } from "../scripts/build-jscdn"
import { createUiPackageAdapters, findUiPackageRoot } from "../scripts/ui-package-adapters"

test("preserves another consumer's GLTF exports outside the STEP adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "standalone-runtime-gltf-"))
  try {
    const dependency = join(directory, "node_modules/circuit-json-to-gltf")
    await mkdir(dependency, { recursive: true })
    await writeFile(join(dependency, "package.json"), JSON.stringify({
      name: "circuit-json-to-gltf", type: "module", main: "index.js",
    }))
    await writeFile(join(dependency, "index.js"), 'export const loadCadComponentMesh = () => "runtime mesh";')
    const entrypoint = join(directory, "index.ts")
    await writeFile(entrypoint, 'export { loadCadComponentMesh } from "circuit-json-to-gltf";')
    const adapters = await createUiPackageAdapters({ findPackageRoot: findUiPackageRoot })
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: "browser",
      plugins: [adapters.plugin],
      throw: false,
    })
    expect(result.success, String(result.logs)).toBe(true)
    expect(await result.outputs[0]!.text()).toContain("runtime mesh")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("selects declared browser modules from the public importer catalog", () => {
  expect(selectDynamicModules(
    { "future-exporter": "1.0.0", "@example/analysis": "2.0.0", "unrelated-viewer": "3.0.0" },
    ["@example/analysis", "future-exporter", "not-installed-exporter"],
  )).toEqual(["@example/analysis", "future-exporter"])
})

test("resolves JS and WASM relative to the CDN module on nested sites", () => {
  expect(
    localizeAssetUrls(
      'import("/assets/manifold.js"); fetch("/assets/manifold.wasm")',
      "/build/jscdn/package/latest/+esm",
      "/build/jscdn",
    ),
  ).toBe(
    'import("../../_assets/manifold.js"); fetch(new URL("../../_assets/manifold.wasm", import.meta.url).href)',
  )
})
