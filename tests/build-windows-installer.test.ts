import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildWindowsInstaller } from "../scripts/build-windows-installer"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "tsci-windows-installer-"))
  roots.push(root)
  await mkdir(join(root, "dist"))
  for (const name of ["dist/LICENSE", "dist/THIRD_PARTY_NOTICES", "dist/licenses.json", "dist/THIRD_PARTY_NOTICES.txt"])
    await writeFile(join(root, name), "fixture notice")
  const binary = join(root, "dist/tsci.exe")
  // Enough of the PE header to exercise architecture validation, never executed.
  const pe = Buffer.alloc(134)
  pe.write("MZ")
  pe.writeUInt32LE(128, 60)
  pe.writeUInt32LE(0x4550, 128)
  pe.writeUInt16LE(0x8664, 132)
  await writeFile(binary, pe)
  return { binary, version: "0.0.3020", output: join(root, "setup.exe"), projectRoot: root, compiler: "not-an-installed-compiler" }
}
test("rejects invalid and overflowing Windows versions before invoking a compiler", async () => {
  const options = await fixture()
  for (const version of ["latest", "1.2", '1.2.3"', "1.2.3-01", "1.2.3-a..b", "1.2.65536"])
    await expect(buildWindowsInstaller({ ...options, version })).rejects.toThrow("Invalid installer version")
})
test("requires every redistribution notice before packaging", async () => {
  const options = await fixture()
  await rm(join(options.projectRoot, "dist/licenses.json"))
  await expect(buildWindowsInstaller(options)).rejects.toThrow("Missing or empty installer input")
})
test("rejects scripts, truncated files and non-x64 executables", async () => {
  const options = await fixture()
  for (const bytes of [Buffer.from("not a Windows executable"), Buffer.alloc(64), (() => {
    const pe = Buffer.alloc(134); pe.write("MZ"); pe.writeUInt32LE(128, 60)
    pe.writeUInt32LE(0x4550, 128); pe.writeUInt16LE(0xaa64, 132); return pe
  })()]) {
    await writeFile(options.binary, bytes)
    await expect(buildWindowsInstaller(options)).rejects.toThrow("Expected a Windows x64 PE executable")
  }
})


test("checkout licenses cannot substitute for missing qualified release notices", async () => {
  const options = await fixture()
  // Windows Git checkouts can use CRLF while the qualified release uses LF.
  await writeFile(join(options.projectRoot, "LICENSE"), "unqualified checkout license\r\n")
  await writeFile(join(options.projectRoot, "THIRD_PARTY_NOTICES"), "checkout notices\r\n")
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES"]) {
    await rm(join(options.projectRoot, "dist", name))
    await expect(buildWindowsInstaller(options)).rejects.toThrow(join("dist", name))
    await writeFile(join(options.projectRoot, "dist", name), "qualified release notice\n")
  }
})
