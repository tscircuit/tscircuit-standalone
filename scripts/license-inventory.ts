import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

// This report follows the compiler's input graph. It is a reproducible notice
// collection aid, not a license compatibility or completeness certification.
const projectRoot = resolve(import.meta.dir, "..")
const metafilePath = resolve(projectRoot, process.argv[2] ?? "dist/build-metafile.json")
const outputDir = resolve(projectRoot, process.argv[3] ?? "dist")
const portablePath = (path: string) => path.split(sep).join("/")
const projectPath = (path: string) => portablePath(relative(projectRoot, path))
const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex")
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const metafileBytes = await readFile(metafilePath)
const metafile = JSON.parse(metafileBytes.toString()) as Bun.BuildMetafile
if (!metafile.inputs || !metafile.outputs) {
  throw new Error("License inventory requires a Bun build metafile with inputs and outputs")
}
const graphInputs = { ...metafile.inputs }
const metafiles = [{ path: projectPath(metafilePath), sha256: sha256(metafileBytes), inputCount: Object.keys(metafile.inputs).length }]
const uiMetafilePath = join(projectRoot, "build/ui/metafile.json")
if (await Bun.file(uiMetafilePath).exists()) {
  const uiMetafileBytes = await readFile(uiMetafilePath)
  const uiMetafile = JSON.parse(uiMetafileBytes.toString()) as Bun.BuildMetafile
  if (!uiMetafile.inputs) throw new Error("Frontend license inventory requires a valid UI compiler input graph")
  Object.assign(graphInputs, uiMetafile.inputs)
  metafiles.push({ path: projectPath(uiMetafilePath), sha256: sha256(uiMetafileBytes), inputCount: Object.keys(uiMetafile.inputs).length })
} else if (Object.keys(graphInputs).some((path) => path.endsWith("generated-ui-assets.ts"))) {
  throw new Error("The compiled binary embeds frontend assets but build/ui/metafile.json is missing. Rebuild the UI before collecting notices.")
}

interface NoticeSource {
  source: string
  sha256: string
}
interface PackageInventory {
  name: string
  version: string
  declaredLicense: unknown
  repository: unknown
  installedPaths: string[]
  inputFiles: string[]
  noticeFiles: NoticeSource[]
  bundledLicenseComments: NoticeSource[]
  reviewReasons: string[]
}

const packageInputs = new Map<string, Set<string>>()
const unassignedInputs: string[] = []
for (const input of Object.keys(graphInputs).sort(compare)) {
  const absoluteInput = resolve(projectRoot, input)
  const normalized = portablePath(absoluteInput)
  const nodeModulesPosition = normalized.lastIndexOf("/node_modules/")
  if (nodeModulesPosition === -1) continue
  const segments = normalized.slice(nodeModulesPosition + "/node_modules/".length).split("/")
  const packageFolder = segments[0]!.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0]!
  const installedRoot = `${normalized.slice(0, nodeModulesPosition)}/node_modules/${packageFolder}`
  try {
    const packageRoot = await realpath(installedRoot)
    const inputs = packageInputs.get(packageRoot) ?? new Set<string>()
    inputs.add(projectPath(absoluteInput))
    packageInputs.set(packageRoot, inputs)
  } catch {
    unassignedInputs.push(projectPath(absoluteInput))
  }
}

const sections: string[] = []
const appendNotice = (heading: string, source: string, content: string): NoticeSource => {
  const digest = sha256(content)
  sections.push(`\n${"=".repeat(72)}\n${heading}\nSource: ${source}\nSHA-256: ${digest}\n\n${content.trimEnd()}\n`)
  return { source, sha256: digest }
}

const noticeFilename = /^(?:licen[cs]e|copying|notice|copyright|third[_-]?party[_-]?notices?)(?:[._-].*)?$/i
const collectNoticeFiles = async (directory: string): Promise<string[]> => {
  const files: string[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => compare(left.name, right.name))) {
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
      files.push(...await collectNoticeFiles(join(directory, entry.name)))
    } else if (entry.isFile() && noticeFilename.test(entry.name)) {
      files.push(join(directory, entry.name))
    }
  }
  return files
}

const readLicenseComments = (source: string): string[] => {
  // Capture preserved legal blocks, including nested upstream bundle banners.
  // Do not infer that every dependency inside a prebuilt bundle is identified.
  const comments = source.match(/\/\*(?:!|\*)[\s\S]*?\*\//g) ?? []
  return comments.filter((comment) => /@license|@preserve|copyright|licensed under|bundled license information|permission is hereby granted/i.test(comment))
}

const packages: PackageInventory[] = []
for (const [packageRoot, inputPaths] of [...packageInputs.entries()].sort(([left], [right]) => compare(left, right))) {
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  const name = String(metadata.name ?? basename(packageRoot))
  const version = String(metadata.version ?? "unknown")
  const inventory: PackageInventory = {
    name,
    version,
    declaredLicense: metadata.license ?? metadata.licenses ?? null,
    repository: metadata.repository ?? null,
    installedPaths: [projectPath(packageRoot)],
    inputFiles: [...inputPaths].sort(compare),
    noticeFiles: [],
    bundledLicenseComments: [],
    reviewReasons: [],
  }
  if (name === "@tscircuit/krt-wasm") {
    inventory.reviewReasons.push("This Rust/WASM router's installed MIT notice does not inventory its compiled transitive dependencies.")
  }
  for (const noticePath of await collectNoticeFiles(packageRoot)) {
    const content = await readFile(noticePath, "utf8")
    inventory.noticeFiles.push(appendNotice(`${name}@${version}: ${portablePath(relative(packageRoot, noticePath))}`, projectPath(noticePath), content))
  }
  // Fonts can carry a separate dedication in an adjacent README rather than
  // inherit the containing package's software license (e.g. Three's Kenpixel).
  for (const inputPath of inventory.inputFiles.filter((path) => /\.(?:ttf|otf|woff2?)$/i.test(path))) {
    const fontDirectory = dirname(resolve(projectRoot, inputPath))
    for (const entry of await readdir(fontDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^readme(?:\.[^.]+)?$/i.test(entry.name)) continue
      const noticePath = join(fontDirectory, entry.name)
      const content = await readFile(noticePath, "utf8")
      if (!/license|copyright|CC0|public domain/i.test(content)) continue
      const source = projectPath(noticePath)
      if (inventory.noticeFiles.some((notice) => notice.source === source)) continue
      inventory.noticeFiles.push(appendNotice(`${name}@${version}: bundled font attribution`, source, content))
    }
  }
  const commentHashes = new Set<string>()
  for (const inputPath of inventory.inputFiles) {
    if (/\.(?:wasm|node|a|so|dylib|dll)$/i.test(inputPath)) {
      if (!inventory.reviewReasons.includes("Native/WASM dependency internals require manual license review.")) {
        inventory.reviewReasons.push("Native/WASM dependency internals require manual license review.")
      }
    }
    if (!/\.(?:[cm]?[jt]sx?)$/i.test(inputPath)) continue
    const source = await readFile(resolve(projectRoot, inputPath), "utf8")
    for (const comment of readLicenseComments(source)) {
      const digest = sha256(comment)
      if (commentHashes.has(digest)) continue
      commentHashes.add(digest)
      inventory.bundledLicenseComments.push(appendNotice(`${name}@${version}: preserved license comment`, inputPath, comment))
      if (/bundled license information/i.test(comment) && !inventory.reviewReasons.includes("Upstream prebuilt bundle contains additional dependencies; banner capture does not identify all package versions or full license texts.")) {
        inventory.reviewReasons.push("Upstream prebuilt bundle contains additional dependencies; banner capture does not identify all package versions or full license texts.")
      }
    }
  }
  if (!inventory.declaredLicense) inventory.reviewReasons.push("Installed package metadata has no declared license.")
  if (inventory.noticeFiles.length === 0) inventory.reviewReasons.push("No installed LICENSE/COPYING/NOTICE file found; verify the full copyright and license text.")
  packages.push(inventory)
}
packages.sort((left, right) => compare(`${left.name}@${left.version}:${left.installedPaths[0]}`, `${right.name}@${right.version}:${right.installedPaths[0]}`))

const runtime = JSON.parse(await readFile(join(projectRoot, "vendor-notices/bun.json"), "utf8"))
if (Bun.version !== runtime.version || Bun.revision !== runtime.revision) {
  throw new Error(`Bun runtime ${Bun.version}+${Bun.revision} does not match vendored license inputs ${runtime.version}+${runtime.revision}; update vendor-notices for this exact runtime.`)
}
const runtimeNoticeFiles: NoticeSource[] = []
for (const file of runtime.files as Array<{ path: string; source: string }>) {
  const content = await readFile(join(projectRoot, "vendor-notices", file.path), "utf8")
  runtimeNoticeFiles.push(appendNotice(`Bun runtime ${runtime.version}: upstream license overview`, file.source, content))
}
const checkedInNotice = await readFile(join(projectRoot, "THIRD_PARTY_NOTICES"), "utf8")
appendNotice("Standalone bundled RP2040 attribution and inventory scope", "THIRD_PARTY_NOTICES", checkedInNotice)

const limitations = [
  "Package metadata is a declaration, not a verified license compatibility conclusion.",
  "Input modules may be prebundled: preserved banners are collected heuristically, but their internal dependency versions/full licenses are not reconstructed.",
  "The Bun native runtime and native/WASM dependency internals need a target-specific audit; this report is not a complete native SBOM or redistribution clearance.",
]
const reviewNeeded = packages.filter((entry) => entry.reviewReasons.length > 0)
const report = {
  schemaVersion: 1,
  scope: "Bun compiled backend and frontend input graphs, copied browser asset notices, installed package notice files, preserved legal comments, bundled RP2040 attribution, and pinned Bun runtime license overview",
  metafile: { path: projectPath(metafilePath), sha256: sha256(metafileBytes), inputCount: Object.keys(metafile.inputs).length },
  metafiles,
  totalInputCount: Object.keys(graphInputs).length,
  runtime: { ...runtime, buildTarget: process.env.BUN_BUILD_TARGET ?? `${process.platform}-${process.arch}`, noticeFiles: runtimeNoticeFiles },
  packageRootCount: packages.length,
  packages,
  unassignedInputs,
  limitations,
}
const header = `tscircuit standalone prototype artifact notices\n\nGenerated from ${metafiles.map((graph) => graph.path).join(" and ")} with Bun ${Bun.version}.\nPackage roots in compiled graphs: ${packages.length}.\nPackages requiring manual follow-up: ${reviewNeeded.length}.\n\n${limitations.join("\n")}\n\nRuntime review:\n${(runtime.reviewReasons as string[]).join("\n")}\n\nPackage follow-up:\n${reviewNeeded.map((entry) => `${entry.name}@${entry.version}: ${entry.reviewReasons.join(" ")}`).join("\n")}\n`
await mkdir(outputDir, { recursive: true })
await writeFile(join(outputDir, "licenses.json"), `${JSON.stringify(report, null, 2)}\n`)
await writeFile(join(outputDir, "THIRD_PARTY_NOTICES.txt"), header + sections.join(""))
console.log(`Collected notices for ${packages.length} compiled package roots (${reviewNeeded.length} need follow-up); written to ${projectPath(outputDir)}. Full release license audit remains required.`)
