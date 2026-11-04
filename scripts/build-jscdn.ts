import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
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

/** Bundle installed browser modules from the importer's public catalog. */
export function selectDynamicModules(
  dependencies: Record<string, string>,
  supportedModules: readonly string[],
): string[] {
  return supportedModules.filter((name) => Object.hasOwn(dependencies, name)).sort()
}

export async function buildJscdn() {
  const outputDir = join(projectRoot, "build/jscdn")
  const { getImportUrl, supportedModules } = await import(
    uiRequire.resolve("@tscircuit/internal-dynamic-import")
  )
  const adapters = await createUiPackageAdapters({ findPackageRoot })
  const uiMetadata = await Bun.file(join(projectRoot, "ui/package.json")).json()
  const specifiers = new Set(selectDynamicModules(uiMetadata.dependencies, supportedModules))
  if (!specifiers.size) throw new Error("No RunFrame dynamic imports found")

  const entries: { in: string; out: string }[] = []
  for (const specifier of [...specifiers].sort()) {
    const root = await findPackageRoot(specifier)
    const out = new URL(getImportUrl(specifier)).pathname.slice(1)
    const entry = out.slice(specifier.length + 1).split("/").slice(1).join("/")
    entries.push({
      in: entry === "+esm" ? uiRequire.resolve(specifier) : join(root, entry),
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
