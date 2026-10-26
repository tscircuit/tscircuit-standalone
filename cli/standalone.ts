import "../lib/register-bundled-modules"
import { setupStandaloneEnvironment } from "../lib/standalone-environment"
import packageMetadata from "../package.json"

await setupStandaloneEnvironment()
Object.assign(globalThis, { TSCIRCUIT_VERSION: packageMetadata.version })
// @ts-expect-error The published CLI does not provide entrypoint declarations.
await import("@tscircuit/cli")
