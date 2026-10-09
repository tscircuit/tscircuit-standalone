import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, relative, resolve, sep } from "node:path"

const projectRoot = resolve(import.meta.dir, "..")
const uiRoot = join(projectRoot, "ui")
const outputRoot = join(projectRoot, "build/ui")
const uiRequire = createRequire(join(uiRoot, "package.json"))

const findPackageRoot = async (name: string): Promise<string> => {
  for (const nodeModules of [join(uiRoot, "node_modules"), join(projectRoot, "node_modules")]) {
    const packageRoot = join(nodeModules, name)
    if (await Bun.file(join(packageRoot, "package.json")).exists()) return realpath(packageRoot)
  }
  throw new Error(`Missing UI dependency ${name}. Run bun install.`)
}
const runFrameRoot = await findPackageRoot("@tscircuit/runframe")
const schematicRoot = await findPackageRoot("@tscircuit/schematic-viewer")
const troikaRoot = await findPackageRoot("troika-three-text")
const manifoldRoot = await findPackageRoot("manifold-3d")
const threeRoot = await findPackageRoot("three")
const reactRoot = await findPackageRoot("react")
const reactDomRoot = await findPackageRoot("react-dom")

for (const packageRoot of [reactRoot, reactDomRoot]) {
  const metadata = await Bun.file(join(packageRoot, "package.json")).json()
  if (metadata.version !== "19.1.0") throw new Error(`UI React isolation failed: ${metadata.name}@${metadata.version}`)
}

const offlinePlugin: Bun.BunPlugin = {
  name: "standalone-offline-ui",
  setup(builder) {
    // Every browser import shares the UI React instance, including imports in
    // GitHub source packages and independently bundled viewer dependencies.
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({ path: uiRequire.resolve(path) }))
    builder.onResolve({ filter: /^react-dom(?:\/.*)?$/ }, ({ path }) => ({ path: uiRequire.resolve(path) }))
    builder.onResolve({ filter: /^circuit-json$/ }, ({ path }) => ({ path: uiRequire.resolve(path) }))
    builder.onResolve({ filter: /^@tscircuit\/runframe\/source$/ }, () => ({ path: join(runFrameRoot, "lib/runner.ts") }))
    builder.onResolve({ filter: /^@tscircuit\/schematic-viewer(?:\/source)?$/ }, () => ({ path: join(schematicRoot, "lib/index.ts") }))
    builder.onResolve({ filter: /^lib\// }, ({ path, importer }) => {
      if (importer.startsWith(runFrameRoot + sep)) return { path: Bun.resolveSync(join(runFrameRoot, path), importer) }
      if (importer.startsWith(schematicRoot + sep)) return { path: Bun.resolveSync(join(schematicRoot, path), importer) }
    })
    builder.onResolve({ filter: /^troika-three-text$/ }, () => ({ path: join(troikaRoot, "src/index.js") }))
    builder.onResolve({ filter: /unicode-font-resolver-client\.factory\.js$/ }, () => ({ path: join(uiRoot, "offline-font-resolver.ts") }))
    builder.onResolve({ filter: /^posthog-js$/ }, () => ({ path: join(uiRoot, "offline-posthog.ts") }))
    builder.onResolve({ filter: /(?:^|\/)FileMenuLeftHeader$/ }, () => ({ path: join(uiRoot, "offline-optional-features.ts") }))
    builder.onResolve({ filter: /^@tscircuit\/internal-dynamic-import$|^@tscircuit\/eval\/worker$|^circuit-json-to-altium$|^@resvg\/resvg-wasm$/ }, () => ({ path: join(uiRoot, "offline-optional-features.ts") }))
    builder.onResolve({ filter: /^\/assets\/manifold\.js$/ }, ({ path }) => ({ path, external: true }))
  },
}

if (!(await Bun.file(join(schematicRoot, "lib/index.ts")).exists())) {
  throw new Error("The UI requires the reviewed schematic-viewer source commit. Pin its GitHub dependency before building.")
}
await mkdir(outputRoot, { recursive: true })
const result = await Bun.build({
  entrypoints: [join(uiRoot, "main.tsx")],
  outdir: outputRoot,
  target: "browser",
  format: "esm",
  minify: true,
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [offlinePlugin],
  throw: false,
})
if (!result.success) throw new AggregateError(result.logs, "Offline RunFrame UI build failed")

const script = result.outputs.find((output) => output.loader === "jsx" || output.path.endsWith(".js"))
const css = result.outputs.find((output) => output.path.endsWith(".css"))
if (!script || !css || !result.metafile) throw new Error("UI compiler did not produce the expected JS, CSS, and metafile")

interface EmbeddedAsset { content: string | Buffer; contentType: string; source: string }
const assets: Record<string, EmbeddedAsset> = {
  "/": { content: await readFile(join(uiRoot, "index.html"), "utf8"), contentType: "text/html; charset=utf-8", source: "ui/index.html" },
  "/favicon.svg": { content: await readFile(join(uiRoot, "favicon.svg"), "utf8"), contentType: "image/svg+xml", source: "ui/favicon.svg" },
  "/assets/app.js": { content: await script.text(), contentType: "text/javascript; charset=utf-8", source: relative(projectRoot, script.path) },
  "/assets/app.css": { content: await css.text(), contentType: "text/css; charset=utf-8", source: relative(projectRoot, css.path) },
  "/assets/manifold.js": { content: await readFile(join(manifoldRoot, "manifold.js"), "utf8"), contentType: "text/javascript; charset=utf-8", source: relative(projectRoot, join(manifoldRoot, "manifold.js")) },
  "/assets/manifold.wasm": { content: await readFile(join(manifoldRoot, "manifold.wasm")), contentType: "application/wasm", source: relative(projectRoot, join(manifoldRoot, "manifold.wasm")) },
  "/assets/font.ttf": { content: await readFile(join(threeRoot, "examples/fonts/ttf/kenpixel.ttf")), contentType: "font/ttf", source: relative(projectRoot, join(threeRoot, "examples/fonts/ttf/kenpixel.ttf")) },
}
// Copied assets participate in the license input graph even when their loader
// is intentionally kept as a same-origin browser resource rather than bundled.
for (const asset of Object.values(assets)) {
  if (asset.source.startsWith("node_modules/") || asset.source.startsWith("ui/node_modules/")) {
    result.metafile.inputs[asset.source.split(sep).join("/")] = { bytes: Buffer.byteLength(asset.content), imports: [] }
  }
}
await writeFile(join(outputRoot, "metafile.json"), `${JSON.stringify(result.metafile, null, 2)}\n`)
await writeFile(join(outputRoot, "asset-manifest.json"), `${JSON.stringify(Object.fromEntries(Object.entries(assets).map(([path, asset]) => [path, { source: asset.source, bytes: Buffer.byteLength(asset.content), contentType: asset.contentType }])), null, 2)}\n`)
const generated = `// Generated by scripts/build-ui.ts; do not edit.\nimport type { UiAsset } from "./ui-assets"\n\nexport const uiAssets: Readonly<Record<string, UiAsset>> = {\n${Object.entries(assets).map(([path, asset]) => `  ${JSON.stringify(path)}: { content: ${typeof asset.content === "string" ? JSON.stringify(asset.content) : `Buffer.from(${JSON.stringify(asset.content.toString("base64"))}, "base64")`}, contentType: ${JSON.stringify(asset.contentType)} },`).join("\n")}\n}\n`
await writeFile(join(projectRoot, "lib/generated-ui-assets.ts"), generated)
console.log(`Built offline RunFrame UI: ${script.size.toLocaleString("en-US")} JS bytes; ${Object.keys(assets).length} embedded resources.`)
