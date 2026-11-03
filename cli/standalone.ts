import { isPrivateBun, runNativeBun } from "../lib/native-bun"
import { bunCache } from "../lib/generated-bun-cache"

if (isPrivateBun()) {
  try {
    process.exitCode = await runNativeBun(bunCache)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
} else {
  await import("../lib/register-bundled-modules")
  const { setupStandaloneEnvironment } = await import(
    "../lib/standalone-environment"
  )
  const { default: packageMetadata } = await import("../package.json")
  await setupStandaloneEnvironment()
  Object.assign(globalThis, { TSCIRCUIT_VERSION: packageMetadata.version })
  // @ts-expect-error The published CLI does not provide entrypoint declarations.
  await import("@tscircuit/cli")
}
