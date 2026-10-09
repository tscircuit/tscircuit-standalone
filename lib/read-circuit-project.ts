import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

const MAX_FILES = 100
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const SOURCE_EXTENSIONS = [
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".json",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]
const SOURCE_EXTENSION_SUBSTITUTIONS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx", ".ts"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
}
const VIRTUAL_EXTENSIONS: Record<string, string> = {
  ".jsx": ".tsx",
  ".mts": ".ts",
  ".cts": ".ts",
  ".mjs": ".js",
  ".cjs": ".js",
}

// These are the exact embedded modules in eval's execution context. Arbitrary
// subpaths must not reach eval's native dynamic import or CDN fallback.
const BUNDLED_MODULES = new Set([
  "@tscircuit/core",
  "tscircuit",
  "@tscircuit/math-utils",
  "@tscircuit/mm",
  "react",
  "react/jsx-runtime",
  "debug",
  "tslib",
  "@tscircuit/props",
])

type SourceModule = {
  absolutePath: string
  sourcePath: string
  virtualPath: string
  registeredBytes: number
}

type ModuleReference = {
  specifier: string
  start: number
  end: number
}

type SourceEdit = { start: number; end: number; replacement: string }

const hasTypeOnlyImport = (node: ts.ImportDeclaration): boolean => {
  const clause = node.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  return (
    !clause.name &&
    !!clause.namedBindings &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  )
}

const hasTypeOnlyExport = (node: ts.ExportDeclaration): boolean =>
  node.isTypeOnly ||
  (!!node.exportClause &&
    ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly))

const isRequireCall = (expression: ts.Expression): boolean => {
  if (ts.isParenthesizedExpression(expression)) {
    return isRequireCall(expression.expression)
  }
  if (ts.isIdentifier(expression)) return expression.text === "require"
  return (
    ts.isPropertyAccessExpression(expression) &&
    (expression.name.text === "require" || isRequireCall(expression.expression))
  )
}

const getSourceReferences = (
  contents: string,
  sourcePath: string,
): { references: ModuleReference[]; edits: SourceEdit[] } => {
  const source = ts.createSourceFile(
    sourcePath,
    contents,
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith(".tsx") || sourcePath.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : /\.(?:js|mjs|cjs)$/.test(sourcePath)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS,
  )
  const diagnostics = (
    source as ts.SourceFile & {
      parseDiagnostics: readonly ts.Diagnostic[]
    }
  ).parseDiagnostics
  if (diagnostics.length) {
    throw new Error(
      `Cannot parse circuit source ${sourcePath}: ${ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, " ")}`,
    )
  }
  const references: ModuleReference[] = []
  const edits: SourceEdit[] = []
  const removeTypeDeclaration = (node: ts.Node) => {
    const start = node.getStart(source)
    const end = node.getEnd()
    edits.push({
      start,
      end,
      replacement: contents.slice(start, end).replace(/[^\r\n]/g, " "),
    })
  }
  const addReference = (literal: ts.StringLiteralLike) => {
    references.push({
      specifier: literal.text,
      start: literal.getStart(source),
      end: literal.getEnd(),
    })
  }
  const visit = (node: ts.Node, functionDepth = 0): void => {
    if (
      functionDepth === 0 &&
      (ts.isAwaitExpression(node) ||
        (ts.isForOfStatement(node) && node.awaitModifier))
    ) {
      throw new Error(
        `Top-level await is not supported by this standalone build in ${sourcePath}. Use synchronous circuit exports.`,
      )
    }
    if (ts.isImportDeclaration(node)) {
      if (hasTypeOnlyImport(node)) {
        removeTypeDeclaration(node)
        return
      }
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        throw new Error(`Unsupported import in ${sourcePath}`)
      }
      addReference(node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (hasTypeOnlyExport(node)) {
        removeTypeDeclaration(node)
        return
      }
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        throw new Error(`Unsupported export import in ${sourcePath}`)
      }
      // Eval's re-export scanner requires export declarations to start a line.
      edits.push({
        start: node.getStart(source),
        end: node.getStart(source),
        replacement: "\n",
      })
      addReference(node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (node.isTypeOnly) {
        removeTypeDeclaration(node)
        return
      }
      throw new Error(
        `CommonJS require imports are not supported in standalone circuit source ${sourcePath}. Use an ES import.`,
      )
    } else if (ts.isCallExpression(node)) {
      if (isRequireCall(node.expression)) {
        throw new Error(
          `require calls are not supported in standalone circuit source ${sourcePath}. Use an ES import.`,
        )
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        throw new Error(
          `Dynamic imports are not supported by this standalone build in ${sourcePath}; use static imports.`,
        )
      }
    }
    const childFunctionDepth = functionDepth + (ts.isFunctionLike(node) ? 1 : 0)
    ts.forEachChild(node, (child) => visit(child, childFunctionDepth))
  }
  visit(source)
  return { references, edits }
}

const hasNodeModulesSegment = (filePath: string): boolean =>
  filePath.split(/[\\/]/).includes("node_modules")

const isProjectPath = (rootPath: string, filePath: string): boolean => {
  const relativePath = path.relative(rootPath, filePath)
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  )
}

const isProjectConfig = (filePath: string): boolean =>
  /^tscircuit\.config\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/.test(
    path.basename(filePath),
  ) || path.basename(filePath) === "tsconfig.json"

/**
 * Read only the circuit's reachable local source graph. Files are flattened into
 * unique virtual module IDs because eval caches imports by their raw specifier;
 * identical relative specifiers in different directories must stay distinct.
 */
export async function readCircuitProject(
  entryFile: string,
  options: { projectDir?: string } = {},
): Promise<{
  fsMap: Record<string, string>
  mainComponentPath: string
}> {
  const entryPath = path.resolve(entryFile)
  if (hasNodeModulesSegment(entryPath)) {
    throw new Error(
      `Circuit ${path.basename(entryPath)} cannot load files from node_modules`,
    )
  }
  let entryDirectory: string
  try {
    entryDirectory = await realpath(path.dirname(entryPath))
  } catch {
    throw new Error(
      `Circuit directory was not found for ${path.basename(entryPath)}`,
    )
  }
  // Canonicalize the parent first, including ordinary directory aliases such
  // as macOS /tmp -> /private/tmp. The final entry segment stays unresolved so
  // registration can still reject entry-file symlinks outside the project.
  const canonicalEntryPath = path.join(entryDirectory, path.basename(entryPath))
  let rootPath = entryDirectory
  if (options.projectDir !== undefined) {
    try {
      rootPath = await realpath(path.resolve(options.projectDir))
      if (!(await stat(rootPath)).isDirectory()) throw new Error()
    } catch {
      throw new Error("The specified circuit project directory was not found")
    }
  } else {
    // Normal CLI projects keep generated imports beside src/, while absolute
    // files outside cwd retain their own source directory as the boundary.
    try {
      const currentDirectory = await realpath(process.cwd())
      if (isProjectPath(currentDirectory, canonicalEntryPath)) {
        rootPath = currentDirectory
      }
    } catch {
      // A removed or inaccessible cwd does not prevent an absolute-file build.
    }
  }

  const modules: SourceModule[] = []
  const modulesByPath = new Map<string, SourceModule>()
  const fsMap: Record<string, string> = {}
  let totalBytes = 0

  const registerModule = async (
    candidate: string,
    description: string,
  ): Promise<SourceModule | undefined> => {
    if (!isProjectPath(rootPath, candidate)) {
      throw new Error(`${description} escapes the circuit project directory`)
    }
    if (hasNodeModulesSegment(candidate)) {
      throw new Error(`${description} cannot load files from node_modules`)
    }
    let resolvedPath: string
    let fileStat: Awaited<ReturnType<typeof stat>>
    try {
      resolvedPath = await realpath(candidate)
      fileStat = await stat(resolvedPath)
    } catch {
      return undefined
    }
    if (!isProjectPath(rootPath, resolvedPath)) {
      throw new Error(
        `${description} follows a symlink outside the circuit project directory`,
      )
    }
    if (hasNodeModulesSegment(resolvedPath)) {
      throw new Error(`${description} cannot load files from node_modules`)
    }
    if (!fileStat.isFile()) return undefined
    if (isProjectConfig(resolvedPath)) {
      throw new Error(
        `${description}: project configuration imports are not supported by standalone build`,
      )
    }
    const extension = path.extname(resolvedPath)
    if (
      !SOURCE_EXTENSIONS.includes(extension) ||
      /\.d\.(?:ts|mts|cts)$/.test(resolvedPath)
    ) {
      throw new Error(
        `${description}: only TS, TSX, JS, JSX and JSON source files are supported`,
      )
    }
    const existing = modulesByPath.get(resolvedPath)
    if (existing) return existing
    if (modules.length >= MAX_FILES) {
      throw new Error(
        `Circuit project exceeds the ${MAX_FILES} source file limit`,
      )
    }
    if (totalBytes + fileStat.size > MAX_SOURCE_BYTES) {
      throw new Error("Circuit project exceeds the 2 MiB source size limit")
    }
    const module: SourceModule = {
      absolutePath: resolvedPath,
      sourcePath: path
        .relative(rootPath, resolvedPath)
        .split(path.sep)
        .join("/"),
      // Eval's local-file branch recognizes these canonical syntax extensions.
      virtualPath: `module-${String(modules.length).padStart(4, "0")}${VIRTUAL_EXTENSIONS[extension] ?? extension}`,
      registeredBytes: fileStat.size,
    }
    modules.push(module)
    modulesByPath.set(resolvedPath, module)
    totalBytes += fileStat.size
    return module
  }

  const mainModule = await registerModule(
    canonicalEntryPath,
    `Circuit ${path.basename(entryPath)}`,
  )
  if (!mainModule)
    throw new Error(`Circuit file ${path.basename(entryPath)} was not found`)

  const resolveSpecifier = async (
    specifier: string,
    importer: SourceModule,
  ): Promise<string> => {
    const description = `Import ${JSON.stringify(specifier)} in ${importer.sourcePath}`
    if (specifier.includes("\\") || specifier.includes("\0")) {
      throw new Error(`${description} is not a supported module path`)
    }
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      if (BUNDLED_MODULES.has(specifier)) return specifier
      throw new Error(
        `${description} is not bundled in tscircuit standalone. No package installation or network request was attempted.`,
      )
    }
    const basePath = path.resolve(
      path.dirname(importer.absolutePath),
      specifier,
    )
    const extension = path.extname(basePath)
    const substitutedPaths = (
      SOURCE_EXTENSION_SUBSTITUTIONS[extension] ?? []
    ).map(
      (substitution) =>
        `${basePath.slice(0, -extension.length)}${substitution}`,
    )
    const candidates = [
      basePath,
      ...substitutedPaths,
      ...SOURCE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
      ...SOURCE_EXTENSIONS.map((extension) =>
        path.join(basePath, `index${extension}`),
      ),
    ]
    for (const candidate of candidates) {
      const importedModule = await registerModule(candidate, description)
      if (importedModule) return `./${importedModule.virtualPath}`
    }
    throw new Error(
      `${description} was not found in the circuit project directory`,
    )
  }

  for (let index = 0; index < modules.length; index++) {
    const module = modules[index]!
    let contents: string
    try {
      contents = await readFile(module.absolutePath, "utf8")
    } catch {
      throw new Error(`Cannot read circuit source ${module.sourcePath}`)
    }
    // Recheck the actual bytes in case a file grew after it was registered.
    totalBytes += Buffer.byteLength(contents) - module.registeredBytes
    if (totalBytes > MAX_SOURCE_BYTES) {
      throw new Error("Circuit project exceeds the 2 MiB source size limit")
    }
    if (module.virtualPath.endsWith(".json")) {
      try {
        JSON.parse(contents)
      } catch {
        throw new Error(`Invalid JSON in circuit source ${module.sourcePath}`)
      }
      fsMap[module.virtualPath] = contents
      continue
    }
    const { references, edits } = getSourceReferences(
      contents,
      module.sourcePath,
    )
    const preloadSpecifiers = new Set<string>()
    for (const reference of references) {
      const resolvedSpecifier = await resolveSpecifier(
        reference.specifier,
        module,
      )
      // Eval's regex scanner misses valid Unicode import bindings. A binding-
      // free import guarantees every AST-resolved dependency is preloaded.
      preloadSpecifiers.add(resolvedSpecifier)
      edits.push({
        start: reference.start,
        end: reference.end,
        replacement: JSON.stringify(resolvedSpecifier),
      })
    }
    edits.sort((a, b) => b.start - a.start || b.end - a.end)
    for (const edit of edits) {
      contents =
        contents.slice(0, edit.start) +
        edit.replacement +
        contents.slice(edit.end)
    }
    const sourceLabel = module.sourcePath.replace(/[\r\n]/g, " ")
    const preloadImports = [...preloadSpecifiers]
      .map((specifier) => `import ${JSON.stringify(specifier)};`)
      .join("\n")
    fsMap[module.virtualPath] =
      `// Standalone source: ${sourceLabel}\n${preloadImports}\n${contents}`
  }
  return { fsMap, mainComponentPath: mainModule.virtualPath }
}
