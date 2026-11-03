import { getInternalBunArguments, runInternalBun } from "../lib/internal-bun"
import { bunShellIntegration, isTscircuitProject } from "../lib/bun-shell"
import packageMetadata from "../package.json"

if (process.argv[2] === "internal") {
  const command = process.argv[3]
  if (command === "bun") {
    try { process.exitCode = await runInternalBun(process.argv.slice(4)) }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  } else if (command === "is-project") {
    process.exitCode = await isTscircuitProject(process.argv.slice(4)) ? 0 : 1
  } else if (command === "shell-init") {
    process.stdout.write(bunShellIntegration(process.argv[4] ?? "bash", getInternalBunArguments([]).slice(0, -2)))
  } else {
    console.error("Unknown internal command")
    process.exitCode = 1
  }
} else {
  await import("../lib/register-bundled-modules")
  const { setupStandaloneEnvironment } = await import("../lib/standalone-environment")
  await setupStandaloneEnvironment()
  Object.assign(globalThis, { TSCIRCUIT_VERSION: packageMetadata.version })
  // @ts-expect-error The published CLI does not provide entrypoint declarations.
  await import("@tscircuit/cli")
}
