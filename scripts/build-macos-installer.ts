import { createReadStream, createWriteStream } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pipeline } from "node:stream/promises"

interface InstallerOptions {
  binary: string
  version: string
  architecture: string
  output: string
  projectRoot?: string
}

const run = (command: string[]) => {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString()
}

/** Build the public payload only; signing credentials stay in sign-macos.sh. */
export async function buildMacosInstaller({
  binary, version, architecture, output,
  projectRoot = resolve(import.meta.dir, ".."),
}: InstallerOptions) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(version)
  if (!match || [match[4], match[5]].some((part) => part?.split(".").some((id) => !id)) ||
    match[4]?.split(".").some((id) => /^0\d+$/.test(id))) throw new Error("Invalid installer version")
  if (architecture !== "arm64" && architecture !== "x64") throw new Error("Expected macOS arm64 or x64")
  const nativeArchitecture = architecture === "x64" ? "x86_64" : "arm64"
  const packageVersion = match.slice(1, 4).join(".")
  const noticeNames = ["LICENSE", "THIRD_PARTY_NOTICES", "licenses.json", "THIRD_PARTY_NOTICES.txt"]
  const inputs = [
    [resolve(binary), "usr/local/bin/tsci"],
    ...noticeNames.map((name) => [
      join(name === "LICENSE" || name === "THIRD_PARTY_NOTICES" ? projectRoot : dirname(resolve(binary)), name),
      `usr/local/share/tscircuit-standalone/${name}`,
    ]),
  ] as [string, string][]
  for (const [source] of inputs) {
    const info = await lstat(source).catch(() => undefined)
    if (!info?.isFile() || info.size === 0) throw new Error(`Missing or empty installer input: ${source}`)
  }
  run(["lipo", resolve(binary), "-verify_arch", nativeArchitecture])
  const minimumVersions = [...run(["vtool", "-show-build", resolve(binary)]).matchAll(/\bminos\s+(\d+(?:\.\d+){1,2})/g)].map((m) => m[1]!)
  if (minimumVersions.length !== 1) throw new Error("Expected one macOS deployment target")
  const destination = resolve(output)
  await mkdir(dirname(destination), { recursive: true })
  const stage = await mkdtemp(join(dirname(destination), ".installer-"))
  try {
    const root = join(stage, "root")
    // Explicit modes also work when the signing shell uses umask 077.
    for (const path of ["usr", "usr/local", "usr/local/bin", "usr/local/share", "usr/local/share/tscircuit-standalone"]) {
      await mkdir(join(root, path), { recursive: true })
      await chmod(join(root, path), 0o755)
    }
    for (const [source, path] of inputs) {
      // Copy bytes into a fresh payload, without importing a source file's
      // download metadata or ACLs. The source and its quarantine stay intact.
      await pipeline(createReadStream(source), createWriteStream(join(root, path)))
      await chmod(join(root, path), path === "usr/local/bin/tsci" ? 0o755 : 0o644)
    }
    await writeFile(join(stage, "requirements.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>arch</key><array><string>${nativeArchitecture}</string></array>
<key>os</key><array><string>${minimumVersions[0]}</string></array>
</dict></plist>`)
    run(["pkgbuild", "--root", root, "--identifier", "com.tscircuit.tsci", "--version", packageVersion,
      "--install-location", "/", "--ownership", "recommended", join(stage, "component.pkg")])
    const distribution = join(stage, "Distribution.xml")
    run(["productbuild", "--synthesize", "--product", join(stage, "requirements.plist"),
      "--package", join(stage, "component.pkg"), distribution])
    const xml = await readFile(distribution, "utf8")
    if (!/<installer-gui-script\b[^>]*>/.test(xml)) throw new Error("Missing Installer distribution")
    // Explicit domains show a redundant destination page even with one option.
    await writeFile(distribution, xml
      .replace(/<installer-gui-script\b[^>]*>/, `$&\n    <title>tscircuit ${version}</title>`)
      .replace(/<options\b/, '<options rootVolumeOnly="true"'))
    const temporaryOutput = join(stage, "unsigned.pkg")
    run(["productbuild", "--distribution", distribution, "--package-path", stage,
      temporaryOutput])
    await rename(temporaryOutput, destination)
    return destination
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const [binary, version, architecture, output, ...extra] = Bun.argv.slice(2)
  if (!binary || !version || !architecture || !output || extra.length) {
    throw new Error("Usage: bun scripts/build-macos-installer.ts BINARY VERSION ARCH OUTPUT")
  }
  console.log(await buildMacosInstaller({ binary, version, architecture, output }))
}
