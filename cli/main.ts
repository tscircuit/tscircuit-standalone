import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { bundledCatalog, generateBundledComponentTsx, getBundledPart } from "../lib/catalog"

const version = "0.0.0-alpha.0"
const help = `tscircuit standalone ${version}

Usage:
  tsci import <supplier-part-number> [--output <file|->]
  tsci catalog [supplier-part-number]
  tsci --version

Imports use the embedded footprinter catalog. Unknown parts fail locally.
Default output: imports/<supplier-part-number>.tsx

This preparation build supports catalog and import. Render/build/dev await
upstream CLI, eval, and RunFrame integration; see docs/implementation-plan.md.
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
