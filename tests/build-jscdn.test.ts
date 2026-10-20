import { expect, test } from "bun:test"
import { getDynamicImports, localizeAssetUrls } from "../scripts/build-jscdn"

test("finds RunFrame's aliased dynamic imports, without unrelated calls", () => {
  expect(
    getDynamicImports(`
    import importer from "@tscircuit/internal-dynamic-import"
    importer("circuit-json-to-gltf")
    importer("circuit-json-to-gltf")
    importer("@tscircuit/circuit-json-schematic-placement-analysis@0.0.46")
    other("not-a-package")
  `),
  ).toEqual([
    "circuit-json-to-gltf",
    "@tscircuit/circuit-json-schematic-placement-analysis@0.0.46",
  ])
  expect(() =>
    getDynamicImports(
      'import load from "@tscircuit/internal-dynamic-import"; load(packageName)',
    ),
  ).toThrow("literal package specifier")
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
