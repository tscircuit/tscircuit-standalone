import { compileBinary, validateBinaryTarget } from "./compile-binary"

validateBinaryTarget(process.env.BUN_BUILD_TARGET)
const uiBuild = Bun.spawnSync([process.execPath, "scripts/build-ui.ts"], {
  stdout: "inherit",
  stderr: "inherit",
})
if (uiBuild.exitCode !== 0) process.exit(uiBuild.exitCode)
await compileBinary()
