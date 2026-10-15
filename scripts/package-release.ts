import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { join, resolve } from "node:path"
import { validateBinaryTarget } from "./compile-binary"

const releaseTargets = {
  "bun-linux-x64": "linux-x64",
  "bun-linux-arm64": "linux-arm64",
  "bun-darwin-x64": "macos-x64",
  "bun-darwin-arm64": "macos-arm64",
  "bun-windows-x64": "windows-x64",
} as const

interface PackageReleaseOptions {
  projectRoot?: string
  target?: string
}

export interface ReleaseAssets {
  binary: string
  notices: string
  archive: string
}

/** Publishable binary, companion notices, and optional archive for one target. */
export async function packageRelease({
  projectRoot = resolve(import.meta.dir, ".."),
  target = process.env.BUN_BUILD_TARGET,
}: PackageReleaseOptions = {}): Promise<ReleaseAssets> {
  validateBinaryTarget(target)
  if (!target) throw new Error("BUN_BUILD_TARGET is required to package a release")
  const platform = releaseTargets[target as keyof typeof releaseTargets]
  const windows = target === "bun-windows-x64"
  const binary = windows ? "tsci.exe" : "tsci"
  const files = [
    [join("dist", binary), binary],
    ["LICENSE", "LICENSE"],
    ["THIRD_PARTY_NOTICES", "THIRD_PARTY_NOTICES"],
    [join("dist", "licenses.json"), "licenses.json"],
    [join("dist", "THIRD_PARTY_NOTICES.txt"), "THIRD_PARTY_NOTICES.txt"],
  ] as const
  for (const [source] of files) {
    const input = await stat(join(projectRoot, source)).catch(() => undefined)
    if (!input?.isFile() || input.size === 0) {
      throw new Error(`Missing or empty release input: ${source}`)
    }
  }
  const outputDir = join(projectRoot, "dist/release")
  await mkdir(outputDir, { recursive: true })
  const stage = await mkdtemp(join(outputDir, ".package-"))
  const extension = windows ? "zip" : "tar.gz"
  const outfile = join(outputDir, `tscircuit-standalone-${platform}.${extension}`)
  const assetName = `tsci-${target.slice("bun-".length)}`
  const binaryAsset = join(outputDir, `${assetName}${windows ? ".exe" : ""}`)
  const noticesAsset = join(outputDir, `${assetName}.notices.txt`)
  const temporaryNotices = join(stage, "notices.txt")
  const temporaryArchive = join(stage, `archive.${extension}`)
  try {
    for (const [source, destination] of files) {
      const path = join(stage, destination)
      await copyFile(join(projectRoot, source), path)
      await chmod(path, destination === binary && !windows ? 0o755 : 0o644)
      // ZIP's earliest representable timestamp; GNU tar normalizes to epoch.
      await utimes(
        path,
        new Date("1980-01-01T00:00:00Z"),
        new Date("1980-01-01T00:00:00Z"),
      )
    }
    const noticeSections = await Promise.all(
      files.slice(1).map(async ([, name]) =>
        `\n${"=".repeat(72)}\n${name}\n\n${await readFile(join(stage, name), "utf8")}`,
      ),
    )
    await writeFile(
      temporaryNotices,
      `tscircuit standalone redistribution notices (${platform})\nKeep this file with the binary when redistributing it.\n${noticeSections.join("\n")}\n`,
    )
    await chmod(temporaryNotices, 0o644)
    const names = files.map(([, name]) => name)
    const command = windows
      ? ["zip", "-X", "-q", temporaryArchive, ...names]
      : [
          "tar",
          "--sort=name",
          "--mtime=@0",
          "--owner=0",
          "--group=0",
          "--numeric-owner",
          "--format=ustar",
          "-czf",
          temporaryArchive,
          ...names,
        ]
    const archive = Bun.spawnSync(command, {
      cwd: stage,
      stdout: "pipe",
      stderr: "pipe",
    })
    if (archive.exitCode !== 0) {
      throw new Error(`Release archive failed: ${archive.stderr.toString().trim()}`)
    }
    const output = await stat(temporaryArchive)
    if (output.size === 0) throw new Error("Release archive is empty")
    await rename(temporaryArchive, outfile)
    await rename(join(stage, binary), binaryAsset)
    await rename(temporaryNotices, noticesAsset)
    return { binary: binaryAsset, notices: noticesAsset, archive: outfile }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const assets = await packageRelease()
  console.log(`Packaged release:\n${Object.values(assets).join("\n")}`)
}
