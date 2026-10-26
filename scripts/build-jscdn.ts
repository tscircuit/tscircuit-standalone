import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import ts from "typescript"
import { writeEmbeddedAssets } from "./write-embedded-assets"
import {
  createUiPackageAdapters,
  findUiPackageRoot as findPackageRoot,
} from "./ui-package-adapters"

const projectRoot = resolve(import.meta.dir, "..")
const uiRequire = createRequire(join(projectRoot, "ui/package.json"))
const portable = (path: string) => path.split(sep).join("/")

export function getDynamicImports(source: string): string[] {
  if (!source.includes("@tscircuit/internal-dynamic-import")) return []
  const file = ts.createSourceFile(
    "module.js",
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const importers = new Set<string>()
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@tscircuit/internal-dynamic-import" &&
      statement.importClause?.name
    ) {
      importers.add(statement.importClause.name.text)
    }
  }
  const specifiers = new Set<string>()
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      importers.has(node.expression.text)
    ) {
      const argument = node.arguments[0]
      if (!argument || !ts.isStringLiteralLike(argument)) {
        throw new Error(
          "RunFrame dynamic imports must use a literal package specifier",
        )
      }
      specifiers.add(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...specifiers]
}

// Browser assets must work both at /jscdn in dev and below a static site's path.
export function localizeAssetUrls(
  source: string,
  filePath: string,
  outputDir: string,
) {
  const file = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const edits: { start: number; end: number; text: string }[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) && node.text.startsWith("/assets/")) {
      let assetPath = portable(
        relative(
          dirname(filePath),
          join(outputDir, "_assets", node.text.slice("/assets/".length)),
        ),
      )
      if (!assetPath.startsWith(".")) assetPath = `./${assetPath}`
      const parent = node.parent
      const isImport =
        ts.isImportDeclaration(parent) ||
        ts.isExportDeclaration(parent) ||
        (ts.isCallExpression(parent) &&
          parent.expression.kind === ts.SyntaxKind.ImportKeyword)
      edits.push({
        start: node.getStart(file),
        end: node.end,
        text: isImport
          ? JSON.stringify(assetPath)
          : `new URL(${JSON.stringify(assetPath)}, import.meta.url).href`,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  for (const edit of edits.reverse())
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  return source
}

export async function buildJscdn() {
  const outputDir = join(projectRoot, "build/jscdn")
  const { getImportUrl, getModuleName } = await import(
    uiRequire.resolve("@tscircuit/internal-dynamic-import")
  )
  const runtimeRequire = createRequire(
    await realpath(join(projectRoot, "node_modules/tscircuit/package.json")),
  )
  const adapters = await createUiPackageAdapters({ findPackageRoot })
  // Follow the same RunFrame dependency graph that the shared CLI serves.
  const runframe = await Bun.build({
    entrypoints: [runtimeRequire.resolve("@tscircuit/runframe")],
    target: "browser",
    metafile: true,
    plugins: [
      adapters.plugin,
      {
        name: "standalone-circuit-json",
        setup(build) {
          build.onResolve({ filter: /^circuit-json$/ }, async () => ({
            path: join(await findPackageRoot("circuit-json"), "dist/index.mjs"),
          }))
        },
      },
    ],
  })
  if (!runframe.success || !runframe.metafile)
    throw new AggregateError(runframe.logs, "Cannot inspect RunFrame imports")
  const specifiers = new Set<string>()
  for (const input of Object.keys(runframe.metafile.inputs)) {
    if (!/\.[cm]?[jt]sx?$/.test(input) || input.includes(":")) continue
    const source = await readFile(resolve(projectRoot, input), "utf8")
    for (const specifier of getDynamicImports(source)) specifiers.add(specifier)
  }
  if (!specifiers.size) throw new Error("No RunFrame dynamic imports found")

  const entries: { in: string; out: string }[] = []
  for (const specifier of [...specifiers].sort()) {
    const name = getModuleName(specifier)
    const root = await findPackageRoot(name)
    const metadata = await Bun.file(join(root, "package.json")).json()
    const { version } = metadata
    const requestedVersion = specifier.slice(name.length + 1)
    if (
      requestedVersion &&
      requestedVersion !== "latest" &&
      requestedVersion !== version
    ) {
      throw new Error(
        `${specifier} is requested by RunFrame, but ${name}@${version} is installed`,
      )
    }
    const out = new URL(getImportUrl(specifier)).pathname.slice(1)
    entries.push({
      in: out.endsWith("/dist/browser.js")
        ? join(root, "dist/browser.js")
        : uiRequire.resolve(name),
      out,
    })
  }
  await rm(outputDir, { recursive: true, force: true })
  const metafile: Bun.BuildMetafile = { inputs: {}, outputs: {} }
  for (const entry of entries) {
    const destination = join(outputDir, entry.out)
    const result = await Bun.build({
      entrypoints: [entry.in],
      outdir: dirname(destination),
      naming: { entry: basename(destination) },
      target: "browser",
      format: "esm",
      minify: true,
      metafile: true,
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [adapters.plugin],
    })
    if (!result.success || !result.metafile)
      throw new AggregateError(result.logs, `JS CDN build failed: ${entry.out}`)
    for (const output of result.outputs) {
      await writeFile(
        output.path,
        localizeAssetUrls(await output.text(), output.path, outputDir),
      )
    }
    Object.assign(metafile.inputs, result.metafile.inputs)
    Object.assign(metafile.outputs, result.metafile.outputs)
  }
  const assets = {
    ...Object.fromEntries(
      Object.entries(adapters.assets).map(([url, asset]) => [
        `_assets/${url.slice("/assets/".length)}`,
        asset,
      ]),
    ),
    ...adapters.viewerAssets,
  }
  for (const [path, asset] of Object.entries(assets)) {
    const destination = join(outputDir, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(
      destination,
      asset.content ?? (await readFile(asset.source)),
    )
    metafile.inputs[portable(relative(projectRoot, asset.source))] = {
      bytes: Bun.file(asset.source).size,
      imports: [],
    }
  }
  await writeFile(
    join(projectRoot, "build/jscdn-metafile.json"),
    JSON.stringify(metafile),
  )
  await writeFile(
    join(outputDir, "manifest.json"),
    `${JSON.stringify([...specifiers].sort(), null, 2)}\n`,
  )
  await writeEmbeddedAssets(
    outputDir,
    join(projectRoot, "lib/generated-jscdn-assets.ts"),
    "jscdnAssets",
  )
  console.log(
    `Prepared ${specifiers.size} RunFrame JS CDN entrypoints and ${Object.keys(assets).length} assets`,
  )
}

if (import.meta.main) await buildJscdn()
