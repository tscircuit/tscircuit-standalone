import { parseArgs } from "node:util"
import type { DatasheetSnapshotPart } from "../lib/datasheet-snapshot-types"
import { bakedAssets } from "../lib/generated-baked-assets"

type DatasheetSummary = Pick<DatasheetSnapshotPart, "datasheet_id" | "chip_name">

const help = `Usage: tsci search <query...> [--datasheets] [--json]

Search the embedded datasheet catalog by chip name. All searches are offline.

Options:
  --datasheets  Search the embedded datasheet catalog (default)
  --json        Output results as JSON
  -h, --help    Display help
`

export async function runStandaloneSearch(args: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        datasheets: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    })
    if (values.help) {
      process.stdout.write(help)
      return 0
    }

    const query = positionals.join(" ").trim()
    if (!query) throw new Error("A search query is required.")

    const inventory = bakedAssets["datasheet-api/datasheets/list"]
    if (!inventory) throw new Error("The embedded datasheet catalog is missing.")
    const { datasheets } = (await Bun.file(inventory).json()) as {
      datasheets: DatasheetSummary[]
    }
    const normalized = query.toLowerCase()
    const matches = datasheets
      .filter(({ chip_name }) => chip_name.toLowerCase().includes(normalized))
      .sort((a, b) =>
        Number(b.chip_name.toLowerCase() === normalized) -
          Number(a.chip_name.toLowerCase() === normalized) ||
        a.chip_name.localeCompare(b.chip_name, "en") ||
        a.datasheet_id.localeCompare(b.datasheet_id, "en"),
      )
      .slice(0, 10)

    if (values.json) {
      const results = matches.map(({ datasheet_id, chip_name }) => ({
        source: "datasheets",
        datasheet_id,
        chip_name,
      }))
      console.log(JSON.stringify({ query, results }, null, 2))
    } else if (matches.length === 0) {
      console.log(`No results found for "${query}" in the embedded datasheet catalog.`)
    } else {
      console.log(`Found ${matches.length} part(s) in the embedded datasheet catalog:`)
      matches.forEach(({ chip_name }, index) => console.log(`${index + 1}. ${chip_name}`))
    }
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error("Standalone search supports the embedded datasheet catalog. Run tsci search --help for usage.")
    return 1
  }
}
