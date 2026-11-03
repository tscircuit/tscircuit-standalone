import { readFile, realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
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

/** Route the published CLI's Bun commands without changing other managers. */
export function routeCliBunCalls(source: string, required = false) {
  if (!source.includes("function getPackageManager(")) {
    if (required) throw new Error("Published CLI package manager has changed")
    return { source, usesRuntime: false }
  }
  const file = ts.createSourceFile("cli.js", source, ts.ScriptTarget.Latest, true)
  const edits: { start: number; end: number; text: string }[] = []
  let probes = 0
  let commands = 0
  const visit = (node: ts.Node, scope = "") => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "detectPackageManager")
      scope = "probe"
    if ((ts.isFunctionDeclaration(node) && node.name?.text === "getPackageManager") ||
      (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "getGlobalDepsInstallCommand"))
      scope = "commands"
    if (scope === "probe" && ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(file) === "Bun" &&
      node.expression.name.text === "spawnSync") {
      const argument = node.arguments[0]
      if (argument && ts.isArrayLiteralExpression(argument) &&
        argument.elements.length === 2 && argument.elements.every(ts.isStringLiteral) &&
        argument.elements[0]!.text === "bun" && argument.elements[1]!.text === "--version") {
        edits.push({ start: argument.getStart(file), end: argument.end, text: '__standaloneBunArguments(["--version"])' })
        probes++
      }
    }
    if (scope === "commands") {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.startsWith("bun ")) {
        edits.push({ start: node.getStart(file), end: node.end, text: `(__standaloneBunCommand() + ${JSON.stringify(node.text.slice(3))})` })
        commands++
      } else if (ts.isTemplateExpression(node) && node.head.text.startsWith("bun ")) {
        const start = node.head.getStart(file) + 1
        if (source.slice(start, start + 3) !== "bun") throw new Error("Published CLI Bun command prefix has changed")
        edits.push({ start, end: start + 3, text: "${__standaloneBunCommand()}" })
        commands++
      }
    }
    ts.forEachChild(node, (child) => visit(child, scope))
  }
  visit(file)
  if (probes !== 1 || commands < 7)
    throw new Error("Published CLI Bun package-manager calls have changed")
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  return { source, usesRuntime: true }
}

/** Resolve version queries while node_modules still exists on the build host. */
export async function inlineCliDependencyVersions(
  source: string,
  getVersion: (packageName: string) => Promise<string>,
) {
  const file = ts.createSourceFile("cli.js", source, ts.ScriptTarget.Latest, true)
  const calls: { start: number; end: number; packageName: string }[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "getTscircuitDependencyVersion"
    ) {
      const argument = node.arguments[0]
      if (node.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument))
        throw new Error("CLI dependency version queries must use a literal package name")
      calls.push({ start: node.getStart(file), end: node.end, packageName: argument.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  for (const { start, end, packageName } of calls.reverse()) {
    const version = await getVersion(packageName)
    if (!version) throw new Error(`Missing installed version of ${packageName}`)
    source = source.slice(0, start) + JSON.stringify(version) + source.slice(end)
  }
  return source
}

async function getPackageVersion(packageName: string, fromDirectory: string) {
  let directory = dirname(Bun.resolveSync(packageName, fromDirectory))
  while (directory !== dirname(directory)) {
    const manifest = Bun.file(join(directory, "package.json"))
    if (await manifest.exists()) {
      const metadata = await manifest.json()
      if (metadata.name === packageName && typeof metadata.version === "string")
        return metadata.version
    }
    directory = dirname(directory)
  }
  throw new Error(`Cannot find the installed version of ${packageName}`)
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
        const runtimeManifest = await realpath(resolve("node_modules/tscircuit/package.json"))
        const runtimeRequire = createRequire(runtimeManifest)
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
        const routed = routeCliBunCalls(source, path.endsWith("/main.js"))
        let adapted = await inlineCliDependencyVersions(
          preferBundledRuntimeModules(routed.source),
          (packageName) => getPackageVersion(packageName, dirname(runtimeManifest)),
        )
        if (routed.usesRuntime) {
          const runtimeImport = `import { getInternalBunArguments as __standaloneBunArguments, getInternalBunCommandPrefix as __standaloneBunCommand } from ${JSON.stringify(resolve("lib/internal-bun.ts"))};\n`
          const offset = adapted.startsWith("#!") ? adapted.indexOf("\n") + 1 : 0
          adapted = adapted.slice(0, offset) + runtimeImport + adapted.slice(offset)
        }
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
