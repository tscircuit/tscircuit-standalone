import { compileBinary, validateBinaryTarget } from "./compile-binary"
import { buildJscdn } from "./build-jscdn"

validateBinaryTarget(process.env.BUN_BUILD_TARGET)
// The GitHub CLI pin contains source; install its locked build dependencies.
const cliInstall = Bun.spawnSync(
  [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
  {
    cwd: "node_modules/@tscircuit/cli",
    stdout: "inherit",
    stderr: "inherit",
  },
)
if (cliInstall.exitCode !== 0) process.exit(cliInstall.exitCode)
await buildJscdn()
await compileBinary()
