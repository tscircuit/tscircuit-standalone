import { runInternalBun } from "../lib/internal-bun"
import packageMetadata from "../package.json"

if (process.argv[2] === "internal" && process.argv[3] === "bun") {
  process.exitCode = await runInternalBun(process.argv.slice(4))
} else {
  await import("../lib/register-bundled-modules")
  const { setupStandaloneEnvironment } = await import("../lib/standalone-environment")
  await setupStandaloneEnvironment()
  Object.assign(globalThis, { TSCIRCUIT_VERSION: packageMetadata.version })
  // @ts-expect-error The published CLI does not provide entrypoint declarations.
  await import("@tscircuit/cli")
}
