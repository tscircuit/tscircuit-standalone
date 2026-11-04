import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { buildWindowsInstaller } from "../../scripts/build-windows-installer"

const directory = resolve("module-probes")
const payload = join(directory, "payload")
await mkdir(payload, { recursive: true })
const pe = Buffer.alloc(70)
pe.write("MZ", 0, "ascii")
pe.writeUInt32LE(64, 60)
pe.writeUInt32LE(0x4550, 64)
pe.writeUInt16LE(0x8664, 68)
await writeFile(join(payload, "tsci.exe"), pe)
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES", "licenses.json", "THIRD_PARTY_NOTICES.txt"])
  await writeFile(join(payload, name), "Startup-only installer fixture\n")
for (const [name, source] of [
  ["baseline", ".github/fixtures/original-installer.iss"],
  ["fixed", "scripts/windows-installer/installer.iss"],
]) {
  const projectRoot = join(directory, name!)
  const scripts = join(projectRoot, "scripts/windows-installer")
  await mkdir(scripts, { recursive: true })
  await copyFile(source!, join(scripts, "installer.iss"))
  await copyFile("scripts/windows-installer/setup.ps1", join(scripts, "setup.ps1"))
  await buildWindowsInstaller({
    binary: join(payload, "tsci.exe"), version: "0.0.3075",
    output: join(projectRoot, "installer.exe"), projectRoot,
  })
}
console.log("Compiled baseline and fixed startup-only installers")
