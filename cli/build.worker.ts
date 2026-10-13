import "../lib/register-bundled-modules"
// @ts-expect-error The CLI worker is resolved by the build plugin.
await import("@tscircuit/cli/build.worker")
