import { mkdir, stat, writeFile } from "node:fs/promises"
import { cliPackageAdapters } from "./cli-package-adapters"

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

/** Compile the shared CLI and prepared assets, without fetching packages. */
export async function compileBinary(): Promise<string> {
  const target = process.env.BUN_BUILD_TARGET
  validateBinaryTarget(target)
  for (const path of [
    "lib/generated-jscdn-assets.ts",
    "lib/generated-baked-assets.ts",
    "lib/generated-skill-assets.ts",
    "build/jscdn-metafile.json",
  ]) {
    const input = await stat(path).catch(() => undefined)
    if (!input?.isFile() || input.size === 0) {
      throw new Error(
        `Missing prepared build input: ${path}. Run bun run build first.`,
      )
    }
  }
  await mkdir("dist", { recursive: true })
  const windows = target?.includes("windows") ?? process.platform === "win32"
  const outfile = windows ? "dist/tsci.exe" : "dist/tsci"
  const result = await Bun.build({
    entrypoints: [
      "cli/standalone.ts",
      "cli/build.worker.ts",
      "cli/snapshot.worker.ts",
    ],
    compile: {
      outfile,
      ...(target ? { target: target as (typeof binaryTargets)[number] } : {}),
    },
    tsconfig: "node_modules/@tscircuit/cli/tsconfig.json",
    minify: true,
    metafile: true,
    plugins: [cliPackageAdapters],
  })
  if (!result.success)
    throw new AggregateError(result.logs, "Binary compilation failed")
  // Bun's embedded payload needs a fresh signature before macOS execution.
  if (process.platform === "darwin" && (!target || target.includes("darwin"))) {
    for (const args of [
      ["--force", "--sign", "-", outfile],
      ["--verify", "--strict", outfile],
    ]) {
      const signing = Bun.spawnSync(["codesign", ...args], {
        stdout: "inherit",
        stderr: "inherit",
      })
      if (signing.exitCode !== 0) throw new Error("macOS code signing failed")
    }
  }
  await writeFile("dist/build-metafile.json", JSON.stringify(result.metafile))
  const notices = Bun.spawnSync(
    [process.execPath, "scripts/license-inventory.ts"],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  if (notices.exitCode !== 0)
    throw new Error(`License inventory failed (${notices.exitCode})`)
  console.log(`Built preparation binary: ${outfile}`)
  return outfile
}

if (import.meta.main) await compileBinary()
