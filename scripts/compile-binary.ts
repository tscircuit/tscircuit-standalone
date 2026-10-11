import { mkdir, stat } from "node:fs/promises"

export const binaryTargets = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
] as const

export function validateBinaryTarget(target: string | undefined): void {
  if (target && !binaryTargets.some((candidate) => candidate === target)) {
    throw new Error(`Unsupported binary target: ${target}`)
  }
}

/** Compile the already built catalog and UI, without fetching or rebuilding them. */
export async function compileBinary(): Promise<string> {
  const target = process.env.BUN_BUILD_TARGET
  validateBinaryTarget(target)
  for (const path of [
    "lib/generated-bundled-parts.ts",
    "lib/generated-ui-assets.ts",
    "build/ui/metafile.json",
  ]) {
    const input = await stat(path).catch(() => undefined)
    if (!input?.isFile() || input.size === 0) {
      throw new Error(
        `Missing prepared build input: ${path}. Run bun run build:ui first.`,
      )
    }
  }
  await mkdir("dist", { recursive: true })
  const windows = target?.includes("windows") ?? process.platform === "win32"
  const outfile = windows ? "dist/tsci.exe" : "dist/tsci"
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      "--minify",
      "--metafile=dist/build-metafile.json",
      ...(target ? [`--target=${target}`] : []),
      `--outfile=${outfile}`,
      "cli/main.ts",
      "lib/build-worker.ts",
    ],
    { stdout: "inherit", stderr: "inherit" },
  )
  if (result.exitCode !== 0)
    throw new Error(`Binary compilation failed (${result.exitCode})`)
  const notices = Bun.spawnSync([process.execPath, "scripts/license-inventory.ts"], {
    stdout: "inherit",
    stderr: "inherit",
  })
  if (notices.exitCode !== 0)
    throw new Error(`License inventory failed (${notices.exitCode})`)
  console.log(`Built preparation binary: ${outfile}`)
  return outfile
}

if (import.meta.main) await compileBinary()
