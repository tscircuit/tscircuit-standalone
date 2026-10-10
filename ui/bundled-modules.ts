import {
  createDynamicImporter,
  registerDynamicModule,
  setDynamicImportResolver,
} from "@tscircuit/internal-dynamic-import"

/** Converter code is bundled; model files and WASM still use local providers. */
export const bundledModuleVersions = {
  "@tscircuit/circuit-json-schematic-placement-analysis": "0.0.46",
  "circuit-json-to-altium": "0.0.1",
  "circuit-json-to-bom-csv": "0.0.19",
  "circuit-json-to-fdm-component-box": "0.0.4",
  "circuit-json-to-gerber": "0.0.111",
  "circuit-json-to-gltf": "0.0.152",
  "circuit-json-to-kicad": "0.0.230",
  "circuit-json-to-lbrn": "0.0.74",
  "circuit-json-to-pnp-csv": "0.0.18",
  "circuit-json-to-step": "0.0.36",
  "circuit-to-svg": "0.0.447",
  "kicad-to-circuit-json": "0.0.142",
} as const

const register = async <TModule>(name: string, module: Promise<TModule>) =>
  registerDynamicModule(name, await module)

// Literal imports let the browser build include every converter without a CDN
// resolver. Register loaded namespaces for converters such as STEP that also
// consult the shared module registry when resolving nested converter imports.
export const bundledModuleLoaders = {
  "@tscircuit/circuit-json-schematic-placement-analysis": () =>
    register("@tscircuit/circuit-json-schematic-placement-analysis", import("@tscircuit/circuit-json-schematic-placement-analysis")),
  // RunFrame also imports this converter directly; expose the same pinned
  // namespace through the generic bundled resolver for other local consumers.
  "circuit-json-to-altium": () =>
    register("circuit-json-to-altium", import("circuit-json-to-altium")),
  "circuit-json-to-bom-csv": () =>
    register("circuit-json-to-bom-csv", import("circuit-json-to-bom-csv")),
  "circuit-json-to-fdm-component-box": () =>
    register("circuit-json-to-fdm-component-box", import("circuit-json-to-fdm-component-box")),
  "circuit-json-to-gerber": () =>
    register("circuit-json-to-gerber", import("circuit-json-to-gerber")),
  "circuit-json-to-gltf": () =>
    register("circuit-json-to-gltf", import("circuit-json-to-gltf")),
  "circuit-json-to-kicad": () =>
    register("circuit-json-to-kicad", import("circuit-json-to-kicad")),
  "circuit-json-to-lbrn": () =>
    register("circuit-json-to-lbrn", import("circuit-json-to-lbrn")),
  "circuit-json-to-pnp-csv": () =>
    register("circuit-json-to-pnp-csv", import("circuit-json-to-pnp-csv")),
  "circuit-json-to-step": () =>
    register("circuit-json-to-step", import("circuit-json-to-step")),
  "circuit-to-svg": () =>
    register("circuit-to-svg", import("circuit-to-svg")),
  "kicad-to-circuit-json": () =>
    register("kicad-to-circuit-json", import("kicad-to-circuit-json")),
} as const

const exactVersionLoaders = Object.fromEntries(
  Object.entries(bundledModuleLoaders).map(([name, loader]) => [
    `${name}@${bundledModuleVersions[name as keyof typeof bundledModuleVersions]}`,
    loader,
  ]),
)

export const bundledModuleManifest = {
  ...bundledModuleLoaders,
  ...exactVersionLoaders,
}

// No fallback: an unsupported package or version must fail locally. Hosts using
// the generic importer outside standalone retain its ordinary online resolver.
export const bundledImporter = createDynamicImporter(bundledModuleManifest)

/** Call before RunFrame mounts, and separately in any worker using the importer. */
export function configureBundledModules(): void {
  setDynamicImportResolver(bundledImporter)
}
