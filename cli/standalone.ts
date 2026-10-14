import "../lib/register-bundled-modules"
import { setupStandaloneEnvironment } from "../lib/standalone-environment"
import packageMetadata from "../package.json"

await setupStandaloneEnvironment()
Object.assign(globalThis, { TSCIRCUIT_VERSION: packageMetadata.version })
// The CLI source entrypoint is selected by the standalone build plugin.
// @ts-expect-error The CLI does not publish entrypoint declarations.
await import("@tscircuit/cli")
