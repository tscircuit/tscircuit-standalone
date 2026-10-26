import { readFile, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { createRequire } from "node:module"
import { findUiPackageRoot } from "./ui-package-adapters"

export function embedCliEvalWorker(source: string, workerBase64: string) {
  const marker = "var standalone_min_default = "
  const position = source.indexOf(marker)
  if (position < 0) throw new Error("Published CLI RunFrame asset is missing")
  const start = position + marker.length
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
    undefined,
    start,
  )
  if (scanner.scan() !== ts.SyntaxKind.StringLiteral)
    throw new Error("Published CLI RunFrame asset is not a string")
  const asset = scanner.getTokenValue()
  const placeholder = '"<--INJECT_TSCIRCUIT_EVAL_WEB_WORKER_BLOB_URL-->"'
  if (!asset.includes(placeholder))
    throw new Error("RunFrame eval worker placeholder is missing")
  const embedded = asset.replaceAll(
    placeholder,
    `URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(workerBase64)}), c => c.charCodeAt(0))], { type: "application/javascript" }))`,
  )
  return (
    source.slice(0, start) +
    JSON.stringify(embedded) +
    source.slice(scanner.getTextPos())
  )
}

function preferBundledRuntimeModules(source: string) {
  const header =
    "async function importFromUserLand(moduleName, projectDir = process.cwd()) {"
  if (source.split(header).length !== 2)
    throw new Error("Published CLI runtime module loader has changed")
  return source.replace(
    header,
    `${header}
  if (moduleName === "tscircuit" || moduleName === "react") return import(moduleName);`,
  )
}

/** Include build-time dependencies that normally resolve files from node_modules. */
export const cliPackageAdapters: Bun.BunPlugin = {
  name: "standalone-cli-packages",
  setup(build) {
    // Worker entrypoints are shipped in dist but are not public package exports.
    const cliEntries: Record<string, string> = {
      "@tscircuit/cli/build.worker": "build/build.worker.js",
      "@tscircuit/cli/snapshot.worker": "snapshot/snapshot.worker.js",
    }
    build.onResolve(
      { filter: /^@tscircuit\/cli\/(?:build|snapshot)\.worker$/ },
      async ({ path }) => ({
        path: await realpath(
          resolve("node_modules/@tscircuit/cli/dist/cli", cliEntries[path]!),
        ),
      }),
    )
    // Adapt both sequential execution and the embedded parallel workers.
    build.onLoad(
      {
        filter:
          /@tscircuit\/cli\/dist\/cli\/(?:main|build\/build\.worker|snapshot\/snapshot\.worker)\.js$/,
      },
      async ({ path }) => {
        const runtimeRequire = createRequire(
          await realpath(resolve("node_modules/tscircuit/package.json")),
        )
        const workerPath = Bun.resolveSync(
          "@tscircuit/eval/worker-entrypoint",
          resolve("."),
        )
        const worker = (await readFile(workerPath)).toString("base64")
        const source = (await readFile(path, "utf8")).replace(
          /\b__require\((["'])([^"']+)\1\)/g,
          (_call, _quote, specifier: string) =>
            `require(${JSON.stringify(runtimeRequire.resolve(specifier))})`,
        )
        // Compiled Bun cannot load the project's import-only package exports.
        // Keep the CLI and authored TSX on the same registered engine/React.
        const adapted = preferBundledRuntimeModules(source)
        return {
          // Only the main entry embeds RunFrame as a JavaScript string.
          contents: path.endsWith("/main.js")
            ? embedCliEvalWorker(adapted, worker)
            : adapted,
          loader: "js",
        }
      },
    )
    build.onLoad(
      { filter: /runframe\/dist\/standalone\.min\.js$/ },
      async ({ path }) => {
        const source = await readFile(path, "utf8")
        const placeholder = '"<--INJECT_TSCIRCUIT_EVAL_WEB_WORKER_BLOB_URL-->"'
        if (!source.includes(placeholder))
          throw new Error("RunFrame eval worker placeholder is missing")
        const workerPath = Bun.resolveSync(
          "@tscircuit/eval/worker-entrypoint",
          resolve("."),
        )
        const worker = (await readFile(workerPath)).toString("base64")
        return {
          contents: source.replaceAll(
            placeholder,
            `URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(worker)}), c => c.charCodeAt(0))], { type: "application/javascript" }))`,
          ),
          loader: "text",
        }
      },
    )
    // Use the existing portable renderer instead of a host-specific native addon.
    build.onResolve({ filter: /^@resvg\/resvg-(?:js|wasm)$/ }, async () => ({
      path: join(await findUiPackageRoot("@resvg/resvg-wasm"), "index.js"),
    }))
    build.onResolve({ filter: /^rollup(?:\/|$)/ }, ({ path }) => ({
      path: fileURLToPath(
        import.meta.resolve(path.replace(/^rollup/, "@rollup/wasm-node")),
      ),
    }))
    build.onLoad({ filter: /rollup-plugin-dts.*\.mjs$/ }, async ({ path }) => ({
      contents: (await readFile(path, "utf8")).replace(
        'require$1("typescript")',
        'require("typescript")',
      ),
      loader: "js",
    }))
    build.onLoad(
      { filter: /wasm-node\/bindings_wasm\.js$/ },
      async ({ path }) => ({
        contents: (await readFile(path, "utf8")).replace(
          "const wasmPath = `${__dirname}/bindings_wasm_bg.wasm`;",
          'import wasmPath from "./bindings_wasm_bg.wasm" with { type: "file" };',
        ),
        loader: "js",
      }),
    )
  },
}
