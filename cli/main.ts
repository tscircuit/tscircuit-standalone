import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { bundledCatalog, generateBundledComponentTsx, getBundledPart } from "../lib/catalog"
import { buildCircuitFile } from "../lib/build"
import packageMetadata from "../package.json"

const version = packageMetadata.version
const help = `tscircuit standalone ${version}

Usage:
  tsci import <supplier-part-number> [--output <file|->]
  tsci catalog [supplier-part-number]
  tsci build <circuit.tsx> [--output-dir <directory>] [--project-dir <directory>] [--timeout-ms <number>]
  tsci --version

Imports use the embedded footprinter catalog. Unknown parts fail locally.
Default output: imports/<supplier-part-number>.tsx

Builds use an embedded evaluator and local routing, and produce Circuit JSON,
PCB/schematic SVG previews, and a diagnostic report. Dev/RunFrame and additional
exports remain planned; see docs/implementation-plan.md.
`

export async function runCli(
  args: string[],
  io: { stdout: (message: string) => void; stderr: (message: string) => void },
): Promise<number> {
  try {
    const [command, ...rest] = args
    if (!command || command === "--help" || command === "-h") {
      io.stdout(help)
      return 0
    }
    if (command === "--version" && rest.length === 0) {
      io.stdout(`${version}\n`)
      return 0
    }
    if (command === "catalog") {
      if (rest.length > 1) throw new Error("Usage: tsci catalog [supplier-part-number]")
      const result = rest[0] ? getBundledPart(rest[0]) : bundledCatalog.parts
      io.stdout(`${JSON.stringify(result, null, 2)}\n`)
      return 0
    }
    if (command === "build") {
      const [filePath, ...options] = rest
      if (!filePath || filePath.startsWith("-")) {
        throw new Error("Usage: tsci build <circuit.tsx> [--output-dir <directory>] [--project-dir <directory>] [--timeout-ms <number>]")
      }
      let outputDir: string | undefined
      let projectDir: string | undefined
      let timeoutMs: number | undefined
      for (let index = 0; index < options.length; index += 2) {
        const value = options[index + 1]
        if (!value || value.startsWith("--")) throw new Error("Build option requires a value")
        if (options[index] === "--output-dir" && outputDir === undefined) outputDir = value
        else if (options[index] === "--project-dir" && projectDir === undefined) projectDir = value
        else if (options[index] === "--timeout-ms" && timeoutMs === undefined) timeoutMs = Number(value)
        else throw new Error(`Unsupported or duplicate build option: ${options[index]}`)
      }
      const result = await buildCircuitFile(filePath, { outputDir, projectDir, timeoutMs })
      const counts = result.report.elementCounts
      io.stdout(`Built ${filePath}: ${counts.pcb_smtpad ?? 0} pads, ${counts.pcb_trace ?? 0} routed traces, ${result.report.errors.length} errors, ${result.report.warnings.length} warnings\n`)
      io.stdout(`Circuit JSON: ${result.outputPaths.circuitJson}\nPCB: ${result.outputPaths.pcbSvg}\nSchematic: ${result.outputPaths.schematicSvg}\nReport: ${result.outputPaths.report}\n`)
      return result.report.errors.length ? 1 : 0
    }
    if (command === "import") {
      const [partNumber, ...options] = rest
      if (!partNumber || partNumber.startsWith("-")) {
        throw new Error("Usage: tsci import <supplier-part-number> [--output <file|->]")
      }
      const part = getBundledPart(partNumber)
      let output = join("imports", `${part.supplierPartNumber}.tsx`)
      if (options.length) {
        if (options.length !== 2 || options[0] !== "--output" || !options[1]) {
          throw new Error("Usage: tsci import <supplier-part-number> [--output <file|->]")
        }
        output = options[1]
      }
      const source = generateBundledComponentTsx(part)
      if (output === "-") {
        io.stdout(source)
      } else {
        await mkdir(dirname(output), { recursive: true })
        await writeFile(output, source, { flag: "wx" })
        io.stdout(`Imported ${part.supplierPartNumber} (${part.manufacturerPartNumber}) to ${output}\n`)
      }
      return 0
    }
    throw new Error(`Unsupported standalone command: ${command}. Run tsci --help for available commands.`)
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  })
}
