import { mkdir } from "node:fs/promises"

const targets = [
  "bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64",
  "bun-darwin-arm64", "bun-windows-x64",
]
const target = process.env.BUN_BUILD_TARGET
if (target && !targets.includes(target)) {
  throw new Error(`Unsupported binary target: ${target}`)
}
await mkdir("dist", { recursive: true })
const windows = target?.includes("windows") ?? process.platform === "win32"
const outfile = windows ? "dist/tsci.exe" : "dist/tsci"
const result = Bun.spawnSync([
  process.execPath, "build", "--compile", "--minify", "--metafile=dist/build-metafile.json",
  ...(target ? [`--target=${target}`] : []),
  `--outfile=${outfile}`, "cli/main.ts", "lib/build-worker.ts",
], { stdout: "inherit", stderr: "inherit" })
if (result.exitCode !== 0) process.exit(result.exitCode)
const notices = Bun.spawnSync([process.execPath, "scripts/license-inventory.ts"], {
  stdout: "inherit", stderr: "inherit",
})
if (notices.exitCode !== 0) process.exit(notices.exitCode)
console.log(`Built preparation binary: ${outfile}`)
