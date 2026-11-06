import { setupStandaloneEnvironment } from "../lib/standalone-environment"
import { runPackagedCli } from "../lib/packaged-runtime"

const runtime = await setupStandaloneEnvironment()
let exitCode: number
try {
  exitCode = await runPackagedCli(runtime)
} finally {
  await runtime.stopServices()
}
process.exit(exitCode!)
