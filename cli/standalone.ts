import { setupStandaloneEnvironment } from "../lib/standalone-environment"
import { runPackagedCli } from "../lib/packaged-runtime"

const runtime = await setupStandaloneEnvironment()
process.exit(await runPackagedCli(runtime))
