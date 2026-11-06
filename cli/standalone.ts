import { setupStandaloneEnvironment } from "../lib/standalone-environment"
import { runPackagedCli } from "../lib/packaged-runtime"
import { runStandaloneSearch } from "./standalone-search"

const args = process.argv.slice(2)
const [command, ...rest] = args[0] === "--" ? args.slice(1) : args
// Search reads the embedded inventory before the shared CLI starts its HTTP server.
if (command === "search") process.exit(await runStandaloneSearch(rest))
if (["help", "--help", "-h"].includes(command ?? "") && rest[0] === "search") {
  process.exit(await runStandaloneSearch(["--help"]))
}

const runtime = await setupStandaloneEnvironment()
// The shared CLI's no-argument menu can invoke its own online search action.
process.exit(await runPackagedCli(runtime, args.length ? args : ["--help"]))
