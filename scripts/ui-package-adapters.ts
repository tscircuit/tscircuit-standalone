import { readFile } from "node:fs/promises"
import { join } from "node:path"

export interface UiPackageAsset {
  source: string
  contentType: string
  /** Transformed loader text; retain source for the license input graph. */
  content?: string
}

interface UiPackageAdapterOptions {
  findPackageRoot: (name: string) => Promise<string>
}

const exactPackage = async (
  findPackageRoot: UiPackageAdapterOptions["findPackageRoot"],
  name: string,
  version: string,
) => {
  const root = await findPackageRoot(name)
  const metadata = await Bun.file(join(root, "package.json")).json()
  if (metadata.version !== version) {
    throw new Error(`UI asset adapter requires ${name}@${version}, found ${metadata.version}`)
  }
  return root
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const fileFilter = (path: string) => new RegExp(`^${escapeRegex(path)}$`)

const replaceSection = (source: string, from: string, to: string, replacement: string) => {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  if (start < 0 || end < 0 || source.indexOf(from, start + from.length) >= 0) {
    throw new Error("Pinned UI package no longer matches its reviewed asset adapter")
  }
  return source.slice(0, start) + replacement + source.slice(end)
}

/** Localizes reviewed nested loaders while retaining the real converters. */
export async function createUiPackageAdapters({ findPackageRoot }: UiPackageAdapterOptions) {
  const [lbrnRoot, fdmRoot, gltfRoot, manifoldRoot, occtRoot, resvgRoot] = await Promise.all([
    exactPackage(findPackageRoot, "circuit-json-to-lbrn", "0.0.74"),
    exactPackage(findPackageRoot, "circuit-json-to-fdm-component-box", "0.0.4"),
    exactPackage(findPackageRoot, "circuit-json-to-gltf", "0.0.152"),
    exactPackage(findPackageRoot, "manifold-3d-exporters", "3.5.1"),
    exactPackage(findPackageRoot, "occt-import-js", "0.0.23"),
    exactPackage(findPackageRoot, "@resvg/resvg-wasm", "2.6.2"),
  ])

  const lbrnPath = join(lbrnRoot, "dist/index.js")
  const lbrnSource = await readFile(lbrnPath, "utf8")
  if (!lbrnSource.includes('const cdnUrl = "https://cdn.jsdelivr.net/npm/manifold-3d@3.0.0/manifold.js";')) {
    throw new Error("LBRN 0.0.74 no longer matches its reviewed Manifold loader")
  }
  const localLbrnSource = replaceSection(
    lbrnSource,
    "var manifoldInstance = null;\nvar getManifold = async () => {",
    "// lib/createCopperShapesForLayer.ts\nvar signedArea",
    `import createLocalExporterManifold from "standalone:exporter-manifold";
var getManifold = async () => {
  const manifold = await createLocalExporterManifold();
  manifold.setup();
  return manifold;
};

`,
  )

  const browserPngPath = join(gltfRoot, "dist/svg-to-png-browser-FB4T2WLU.js")
  const nativePngPath = join(gltfRoot, "dist/svg-to-png-AFPNZW36.js")
  const browserPngSource = await readFile(browserPngPath, "utf8")
  const nativePngSource = await readFile(nativePngPath, "utf8")
  if (!browserPngSource.includes('"https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm"') ||
      !nativePngSource.includes('import { Resvg } from "@resvg/resvg-js";')) {
    throw new Error("GLTF 0.0.152 no longer matches its reviewed PNG loaders")
  }
  const localBrowserPngSource = replaceSection(
    browserPngSource,
    "var wasmInitialized = false;",
    "async function svgToPng(svgString, options = {}) {",
    `import { Resvg, initWasm } from "@resvg/resvg-wasm";
var resvgReady;
async function ensureWasmInitialized() {
  resvgReady ??= initWasm(fetch("/assets/resvg.wasm"));
  await resvgReady;
}
`,
  )

  const occtPath = join(occtRoot, "dist/occt-import-js.js")
  const occtSource = await readFile(occtPath, "utf8")
  if (!occtSource.includes("var occtimportjs =") || !occtSource.includes("module.exports = occtimportjs")) {
    throw new Error("OCCT 0.0.23 no longer matches its reviewed browser loader")
  }

  const assets: Record<string, UiPackageAsset> = {
    "/assets/manifold-exporters.js": {
      source: join(manifoldRoot, "manifold.js"),
      contentType: "text/javascript; charset=utf-8",
    },
    "/assets/manifold-exporters.wasm": {
      source: join(manifoldRoot, "manifold.wasm"),
      contentType: "application/wasm",
    },
    "/assets/occt-import-js.js": {
      source: occtPath,
      contentType: "text/javascript; charset=utf-8",
      // Execute the genuine loader as ESM in a browser. Its guarded Node branch
      // remains dormant and therefore needs no fs/path polyfills in the bundle.
      content: `${occtSource}\nexport default occtimportjs;\n`,
    },
    "/assets/occt-import-js.wasm": {
      source: join(occtRoot, "dist/occt-import-js.wasm"),
      contentType: "application/wasm",
    },
    "/assets/resvg.wasm": {
      source: join(resvgRoot, "index_bg.wasm"),
      contentType: "application/wasm",
    },
  }

  const plugin: Bun.BunPlugin = {
    name: "standalone-ui-package-assets",
    setup(builder) {
      const namespace = "standalone-package-assets"
      // STEP also declares a transitive GLTF dependency. Keep its nested import
      // on the same reviewed converter and rasterizer as the UI manifest.
      builder.onResolve({ filter: /^circuit-json-to-gltf$/ }, () => ({ path: join(gltfRoot, "dist/index.js") }))
      builder.onResolve({ filter: /^standalone:exporter-manifold$/ }, () => ({ path: "exporter-manifold", namespace }))
      builder.onResolve({ filter: /^manifold-3d$/ }, ({ importer }) => {
        if (importer.startsWith(fdmRoot + "/")) return { path: "exporter-manifold", namespace }
      })
      builder.onResolve({ filter: /^occt-import-js$|^https:\/\/cdn\.jsdelivr\.net\/npm\/occt-import-js@0\.0\.23\/\+esm$/ }, () => ({ path: "occt", namespace }))
      builder.onResolve({ filter: /^occt-import-js\/dist\/occt-import-js\.wasm\?url$/ }, () => ({ path: "occt-wasm-url", namespace }))
      builder.onResolve({ filter: /^@resvg\/resvg-wasm\/index_bg\.wasm\?url$/ }, () => ({ path: "resvg-wasm-url", namespace }))
      builder.onResolve({ filter: /^\/assets\/(?:manifold-exporters|occt-import-js)\.js$/ }, ({ path }) => ({ path, external: true }))

      builder.onLoad({ filter: fileFilter(lbrnPath) }, () => ({ contents: localLbrnSource, loader: "js" }))
      builder.onLoad({ filter: fileFilter(browserPngPath) }, () => ({ contents: localBrowserPngSource, loader: "js" }))
      // The alternate runtime branch uses the same browser rasterizer; the
      // native Resvg addon and filesystem font staging do not enter this graph.
      builder.onLoad({ filter: fileFilter(nativePngPath) }, () => ({
        contents: 'export { svgToPng, svgToPngDataUrl } from "./svg-to-png-browser-FB4T2WLU.js";\n',
        loader: "js",
      }))
      builder.onLoad({ filter: /.*/, namespace }, ({ path }) => {
        if (path === "occt-wasm-url") return { contents: 'export default "/assets/occt-import-js.wasm";', loader: "js" }
        if (path === "resvg-wasm-url") return { contents: 'export default "/assets/resvg.wasm";', loader: "js" }
        if (path === "occt") return {
          contents: `import createOcct from "/assets/occt-import-js.js";
export default function createLocalOcct(options = {}) {
  return createOcct({ ...options, locateFile: () => "/assets/occt-import-js.wasm" });
}
`,
          loader: "js",
        }
        if (path === "exporter-manifold") return {
          contents: `var pending;
export default function createLocalExporterManifold() {
  pending ??= (async () => {
    const { default: createManifold } = await import("/assets/manifold-exporters.js");
    const module = await createManifold({ locateFile: () => "/assets/manifold-exporters.wasm" });
    const setup = module.setup.bind(module);
    let initialized = false;
    module.setup = () => { if (!initialized) { setup(); initialized = true; } };
    return module;
  })();
  return pending;
}
`,
          loader: "js",
        }
      })
    },
  }

  return { plugin, assets }
}
