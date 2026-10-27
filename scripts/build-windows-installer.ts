import { copyFile, lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

interface InstallerOptions {
  binary: string
  version: string
  output: string
  projectRoot?: string
  compiler?: string
}

/** Build from the qualified executable; never install packages or fetch runtime files. */
export async function buildWindowsInstaller({
  binary, version, output,
  projectRoot = resolve(import.meta.dir, ".."),
  compiler = process.env.ISCC || "ISCC.exe",
}: InstallerOptions) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(version)
  if (!match || match.slice(1, 4).some((part) => Number(part) > 65535) ||
    [match[4], match[5]].some((part) => part?.split(".").some((id) => !id)) ||
    match[4]?.split(".").some((id) => /^0\d+$/.test(id))) throw new Error("Invalid installer version")
  const sourceBinary = resolve(binary)
  const inputs = [
    [sourceBinary, "tsci.exe"],
    ...["LICENSE", "THIRD_PARTY_NOTICES", "licenses.json", "THIRD_PARTY_NOTICES.txt"].map((name) => [
      // The release archive is authoritative, including its original line endings.
      // Do not substitute files from a platform-dependent Git checkout.
      join(dirname(sourceBinary), name), name,
    ]),
  ] as [string, string][]
  for (const [source] of inputs) {
    const info = await lstat(source).catch(() => undefined)
    if (!info?.isFile() || !info.size) throw new Error(`Missing or empty installer input: ${source}`)
  }
  const handle = await open(sourceBinary, "r")
  try {
    const dos = Buffer.alloc(64)
    const header = Buffer.alloc(6)
    const first = await handle.read(dos, 0, dos.length, 0)
    const pe = await handle.read(header, 0, header.length, dos.readUInt32LE(60))
    if (first.bytesRead !== 64 || dos.toString("ascii", 0, 2) !== "MZ" ||
      pe.bytesRead !== 6 || header.readUInt32LE(0) !== 0x4550 || header.readUInt16LE(4) !== 0x8664)
      throw new Error("Expected a Windows x64 PE executable")
  } finally {
    await handle.close()
  }
  const destination = resolve(output)
  if (!destination.toLowerCase().endsWith(".exe")) throw new Error("Installer output must end in .exe")
  await mkdir(dirname(destination), { recursive: true })
  const stage = await mkdtemp(join(dirname(destination), ".windows-installer-"))
  try {
    const payload = join(stage, "payload")
    await mkdir(payload)
    for (const [source, name] of inputs) await copyFile(source, join(payload, name))
    for (const name of ["installer.iss", "setup.ps1"])
      await copyFile(join(projectRoot, "scripts/windows-installer", name), join(stage, name))
    const result = Bun.spawn([
      compiler, `/DAppVersion=${version}`, `/DNumericVersion=${match.slice(1, 4).join(".")}.0`,
      `/DPayloadDir=${payload}`, `/O${stage}`, "/Fsetup", join(stage, "installer.iss"),
    ], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      result.exited, new Response(result.stdout).text(), new Response(result.stderr).text(),
    ])
    if (code !== 0) throw new Error(`Windows installer compilation failed:\n${stdout}\n${stderr}`)
    const temporary = join(stage, "setup.exe")
    const compiled = await lstat(temporary).catch(() => undefined)
    if (!compiled?.isFile() || !compiled.size) throw new Error("Windows installer is missing or empty")
    await rename(temporary, destination)
    return destination
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const [binary, version, output, ...extra] = Bun.argv.slice(2)
  if (!binary || !version || !output || extra.length)
    throw new Error("Usage: bun scripts/build-windows-installer.ts BINARY VERSION OUTPUT")
  console.log(await buildWindowsInstaller({ binary, version, output }))
}
