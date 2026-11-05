import { createReadStream, createWriteStream } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
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
    [resolve(binary), "bin/tsci"],
    ...noticeNames.map((name) => [
      join(name === "LICENSE" || name === "THIRD_PARTY_NOTICES" ? projectRoot : dirname(resolve(binary)), name),
      `share/tscircuit-standalone/${name}`,
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
    for (const path of ["bin", "share", "share/tscircuit-standalone"]) {
      await mkdir(join(root, path), { recursive: true })
      await chmod(join(root, path), 0o755)
    }
    for (const [source, path] of inputs) {
      // Copy bytes into a fresh payload, without importing a source file's
      // download metadata or ACLs. The source and its quarantine stay intact.
      await pipeline(createReadStream(source), createWriteStream(join(root, path)))
      await chmod(join(root, path), path === "bin/tsci" ? 0o755 : 0o644)
    }
    run(["pkgbuild", "--root", root, "--identifier", "com.tscircuit.tsci", "--version", packageVersion,
      "--install-location", "/.local", "--ownership", "recommended", join(stage, "component.pkg")])
    const distribution = join(stage, "Distribution.xml")
    // A custom location is volume-relative, whereas a component's normal
    // install location is relative to its selected domain. Keep the default
    // choice home-relative and enable the folder picker through an opt-in choice.
    await writeFile(distribution, `<?xml version="1.0" encoding="UTF-8"?>
<installer-gui-script minSpecVersion="2">
  <title>tscircuit ${version}</title>
  <options customize="always" require-scripts="true" hostArchitectures="${nativeArchitecture}"/>
  <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false"/>
  <volume-check><allowed-os-versions><os-version min="${minimumVersions[0]}"/></allowed-os-versions></volume-check>
  <choices-outline><line choice="tsci-default"/><line choice="tsci-custom"/></choices-outline>
  <choice id="tsci-default" title="Install in ~/.local" enabled="false" selected="!choices['tsci-custom'].selected">
    <pkg-ref id="com.tscircuit.tsci"/>
  </choice>
  <choice id="tsci-custom" title="Choose another folder" start_selected="false"
    description="Select a folder in your home directory using Location &gt; Other…"
    customLocation="/" customLocationAllowAlternateVolumes="false">
    <pkg-ref id="com.tscircuit.tsci"/>
  </choice>
  <pkg-ref id="com.tscircuit.tsci" version="${packageVersion}">component.pkg</pkg-ref>
</installer-gui-script>`)
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
