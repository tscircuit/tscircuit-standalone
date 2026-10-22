import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildMacosInstaller } from "../scripts/build-macos-installer"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "tsci-installer-test-"))
  roots.push(root)
  await mkdir(join(root, "dist"))
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES", "dist/licenses.json", "dist/THIRD_PARTY_NOTICES.txt"])
    await writeFile(join(root, name), `Fixture ${name}\n`)
  const binary = join(root, "dist/tsci")
  await writeFile(binary, "Fixture binary")
  return {
    root, binary,
    options: { binary, version: "0.0.3003", architecture: process.arch === "arm64" ? "arm64" : "x64", output: join(root, "installer.pkg"), projectRoot: root },
  }
}

test("installer inputs reject invalid versions, targets, and missing licenses before packaging", async () => {
  const { options } = await fixture()
  for (const version of ["latest", "1.2", "1.2.3</title>", "1.2.3-01"])
    await expect(buildMacosInstaller({ ...options, version })).rejects.toThrow("Invalid installer version")
  await expect(buildMacosInstaller({ ...options, architecture: "linux-arm64" })).rejects.toThrow("Expected macOS")
  await rm(join(options.projectRoot, "LICENSE"))
  await expect(buildMacosInstaller(options)).rejects.toThrow("Missing or empty installer input")
})

// Run real Apple packaging tools on both native macOS CI runners. No signing
// credentials, installation, networking, or changes to the host are needed.
test.skipIf(process.platform !== "darwin")("native package preserves the executable, permissions, licenses and Installer requirements", async () => {
  const { root, binary, options } = await fixture()
  const source = join(root, "main.c")
  await writeFile(source, 'int main(void) { return 0; }\n')
  const compiled = Bun.spawnSync(["cc", source, "-o", binary], { stdout: "pipe", stderr: "pipe" })
  expect(compiled.exitCode, compiled.stderr.toString()).toBe(0)
  expect(Bun.spawnSync(["xattr", "-w", "com.apple.quarantine", "0081;00000000;Fixture;", binary]).exitCode).toBe(0)
  await chmod(binary, 0o600)
  const previousMask = process.umask(0o077)
  try {
    await buildMacosInstaller({ ...options, version: "0.0.3003-beta.1+build.2" })
  } finally {
    process.umask(previousMask)
  }
  const expanded = join(root, "expanded")
  const expansion = Bun.spawnSync(["pkgutil", "--expand-full", options.output, expanded], { stdout: "pipe", stderr: "pipe" })
  expect(expansion.exitCode, expansion.stderr.toString()).toBe(0)
  const payload = join(expanded, "component.pkg/Payload")
  const executable = join(payload, "usr/local/bin/tsci")
  expect(await readFile(executable)).toEqual(await readFile(binary))
  expect((await stat(executable)).mode & 0o777).toBe(0o755)
  // Packaging must not inherit browser metadata, or change the source file.
  expect(Bun.spawnSync(["xattr", "-p", "com.apple.quarantine", executable]).exitCode).not.toBe(0)
  expect(Bun.spawnSync(["xattr", "-p", "com.apple.quarantine", binary]).exitCode).toBe(0)
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES", "licenses.json", "THIRD_PARTY_NOTICES.txt"]) {
    const installed = join(payload, "usr/local/share/tscircuit-standalone", name)
    expect((await stat(installed)).mode & 0o777).toBe(0o644)
    expect(await readFile(installed)).toEqual(await readFile(join(name.endsWith(".json") || name.endsWith(".txt") ? join(root, "dist") : root, name)))
  }
  for (const path of ["usr", "usr/local", "usr/local/bin", "usr/local/share", "usr/local/share/tscircuit-standalone"])
    expect((await stat(join(payload, path))).mode & 0o777).toBe(0o755)
  const info = await readFile(join(expanded, "component.pkg/PackageInfo"), "utf8")
  expect(info).toContain('identifier="com.tscircuit.tsci"')
  expect(info).toContain('version="0.0.3003"')
  expect(info).toContain('install-location="/"')
  expect(info).not.toContain("<scripts>")
  const distribution = await readFile(join(expanded, "Distribution"), "utf8")
  expect(distribution).toContain(`hostArchitectures="${process.arch === "arm64" ? "arm64" : "x86_64"}"`)
  expect(distribution).toContain("<allowed-os-versions>")
  expect(distribution).toContain('enable_currentUserHome="false"')
  expect(distribution).toContain("Conclusion.html")
  expect((await readdir(root)).some((name) => name.startsWith(".installer-"))).toBe(false)
}, 30_000)

test.skipIf(process.platform !== "darwin")("a wrong-architecture binary cannot be packaged", async () => {
  const { root, binary, options } = await fixture()
  const source = join(root, "main.c")
  await writeFile(source, "int main(void) { return 0; }\n")
  expect(Bun.spawnSync(["cc", source, "-o", binary]).exitCode).toBe(0)
  await expect(buildMacosInstaller({ ...options, architecture: process.arch === "arm64" ? "x64" : "arm64" })).rejects.toThrow("lipo failed")
  expect(await Bun.file(options.output).exists()).toBe(false)
})
