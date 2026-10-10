import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, relative, resolve, sep } from "node:path"
import { createUiPackageAdapters } from "./ui-package-adapters"

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
const circuitJsonRoot = await findPackageRoot("circuit-json")
const troikaRoot = await findPackageRoot("troika-three-text")
const manifoldRoot = await findPackageRoot("manifold-3d")
const threeRoot = await findPackageRoot("three")
const reactRoot = await findPackageRoot("react")
const reactDomRoot = await findPackageRoot("react-dom")

for (const packageRoot of [reactRoot, reactDomRoot]) {
  const metadata = await Bun.file(join(packageRoot, "package.json")).json()
  if (metadata.version !== "19.1.0") throw new Error(`UI React isolation failed: ${metadata.name}@${metadata.version}`)
}

const packageAdapters = await createUiPackageAdapters({ findPackageRoot })

const bundledPlugin: Bun.BunPlugin = {
  name: "standalone-bundled-ui",
  setup(builder) {
    // Every browser import shares the UI React instance, including imports in
    // independently bundled viewer dependencies.
    builder.onResolve({ filter: /^zod$/ }, ({ path }) => ({ path: uiRequire.resolve(path) }))
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({ path: uiRequire.resolve(path) }))
    builder.onResolve({ filter: /^react-dom(?:\/.*)?$/ }, ({ path }) => ({ path: uiRequire.resolve(path) }))
    builder.onResolve({ filter: /^circuit-json$/ }, () => ({ path: join(circuitJsonRoot, "dist/index.mjs") }))
    // Troika's bundled distribution inlines its network font resolver. Its
    // published module:src entry lets us substitute the local glyph resolver.
    builder.onResolve({ filter: /^troika-three-text$/ }, () => ({ path: join(troikaRoot, "src/index.js") }))
    builder.onResolve({ filter: /unicode-font-resolver-client\.factory\.js$/ }, () => ({ path: join(uiRoot, "bundled-font-resolver.ts") }))
    builder.onResolve({ filter: /^\/assets\/manifold\.js$/ }, ({ path }) => ({ path, external: true }))
  },
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
  plugins: [packageAdapters.plugin, bundledPlugin],
  throw: false,
})
if (!result.success) throw new AggregateError(result.logs, "Bundled RunFrame UI build failed")

// The evaluator has its own consistent React/core dependency graph. Do not
// apply the UI's React isolation aliases to this dedicated worker bundle.
const workerResult = await Bun.build({
  entrypoints: [join(uiRoot, "eval-worker-runtime.ts")],
  outdir: join(outputRoot, "worker"),
  tsconfig: join(projectRoot, "tsconfig.json"),
  target: "browser",
  format: "esm",
  minify: true,
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
  throw: false,
})
if (!workerResult.success) throw new AggregateError(workerResult.logs, "Bundled evaluator build failed")
const workerScript = workerResult.outputs.find((output) => output.path.endsWith(".js"))
if (!workerScript || !workerResult.metafile) throw new Error("Evaluator compiler did not produce JS and a metafile")
if (result.metafile) Object.assign(result.metafile.inputs, workerResult.metafile.inputs)

const script = result.outputs.find((output) => output.loader === "jsx" || output.path.endsWith(".js"))
const css = result.outputs.find((output) => output.path.endsWith(".css"))
if (!script || !css || !result.metafile) throw new Error("UI compiler did not produce the expected JS, CSS, and metafile")

interface EmbeddedAsset { content: string | Buffer; contentType: string; source: string }
const assets: Record<string, EmbeddedAsset> = {
  "/": { content: await readFile(join(uiRoot, "index.html"), "utf8"), contentType: "text/html; charset=utf-8", source: "ui/index.html" },
  "/favicon.svg": { content: await readFile(join(uiRoot, "favicon.svg"), "utf8"), contentType: "image/svg+xml", source: "ui/favicon.svg" },
  "/assets/host-config.js": { content: await readFile(join(uiRoot, "host-config.js"), "utf8"), contentType: "text/javascript; charset=utf-8", source: "ui/host-config.js" },
  "/assets/app.js": { content: await script.text(), contentType: "text/javascript; charset=utf-8", source: relative(projectRoot, script.path) },
  "/assets/eval-worker.js": { content: await workerScript.text(), contentType: "text/javascript; charset=utf-8", source: relative(projectRoot, workerScript.path) },
  "/assets/app.css": { content: await css.text(), contentType: "text/css; charset=utf-8", source: relative(projectRoot, css.path) },
  "/assets/manifold.js": { content: await readFile(join(manifoldRoot, "manifold.js"), "utf8"), contentType: "text/javascript; charset=utf-8", source: relative(projectRoot, join(manifoldRoot, "manifold.js")) },
  "/assets/manifold.wasm": { content: await readFile(join(manifoldRoot, "manifold.wasm")), contentType: "application/wasm", source: relative(projectRoot, join(manifoldRoot, "manifold.wasm")) },
  "/assets/font.ttf": { content: await readFile(join(threeRoot, "examples/fonts/ttf/kenpixel.ttf")), contentType: "font/ttf", source: relative(projectRoot, join(threeRoot, "examples/fonts/ttf/kenpixel.ttf")) },
}
for (const [url, asset] of Object.entries(packageAdapters.assets)) {
  assets[url] = {
    content: asset.content ?? await readFile(asset.source),
    contentType: asset.contentType,
    source: relative(projectRoot, asset.source),
  }
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
console.log(`Built bundled RunFrame UI: ${script.size.toLocaleString("en-US")} JS bytes; ${Object.keys(assets).length} embedded resources.`)
