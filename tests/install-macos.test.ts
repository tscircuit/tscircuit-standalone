import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runInstallerInTerminal } from "./helpers/installer-terminal"

const installer = resolve(import.meta.dir, "../scripts/install-macos.sh")
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const fixture = async (architecture = "arm64", releaseTag = "daily-2026-10-15") => {
  const root = await mkdtemp(join(tmpdir(), "tsci-macos-installer-"))
  directories.push(root)
  const bin = join(root, "bin")
  const release = join(root, "release")
  const payload = join(root, "payload")
  const temporary = join(root, "temporary")
  for (const path of [bin, release, payload, temporary]) await mkdir(path)
  const files = {
    tsci: "#!/bin/sh\nprintf 'fixture version\\n'\n",
    LICENSE: "project license\n",
    THIRD_PARTY_NOTICES: "project notices\n",
    "licenses.json": "{}\n",
    "THIRD_PARTY_NOTICES.txt": "dependency notices\n",
  }
  for (const [name, content] of Object.entries(files)) await writeFile(join(payload, name), content)
  await chmod(join(payload, "tsci"), 0o755)
  const archive = `tscircuit-standalone-macos-${architecture === "x86_64" ? "x64" : "arm64"}.tar.gz`
  expect(Bun.spawnSync(["tar", "-czf", join(release, archive), "-C", payload, ...Object.keys(files)]).exitCode).toBe(0)
  const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(join(release, archive)).arrayBuffer()).digest("hex")
  const pkg = archive.replace(/\.tar\.gz$/, ".pkg")
  await writeFile(join(release, pkg), "Fixture signed installer\n")
  const pkgHash = new Bun.CryptoHasher("sha256").update(await Bun.file(join(release, pkg)).arrayBuffer()).digest("hex")
  const manifest = `${hash}  ${archive}\n${pkgHash}  ${pkg}\n${"0".repeat(64)}  tscircuit-standalone-linux-x64.tar.gz\n`
  await writeFile(join(release, "SHA256SUMS"), manifest)
  await writeFile(join(bin, "uname"), `#!/bin/sh\nif [ "$1" = -s ]; then printf '%s\\n' "\${FIXTURE_OS:-Darwin}"; else printf '%s\\n' '${architecture}'; fi\n`)
  // Serve the official script, release metadata and assets without network access.
  await writeFile(join(bin, "curl"), `#!${process.execPath}\n` + String.raw`
import { copyFileSync, appendFileSync, readFileSync, writeFileSync } from "node:fs"
const args = process.argv.slice(2)
const url = args.find((arg) => arg.startsWith("https://"))
appendFileSync(process.env.FIXTURE_CALLS, url + "\n")
if (process.env.FIXTURE_DOWNLOAD_FAILURE) process.exit(22)
if (url === "https://raw.githubusercontent.com/tscircuit/tscircuit-standalone/main/scripts/install.sh" ||
    url === "https://raw.githubusercontent.com/tscircuit/tscircuit-standalone/main/scripts/install-macos.sh") {
  const source = url.endsWith("/install.sh") ? process.env.FIXTURE_ENTRY : process.env.FIXTURE_INSTALLER
  const content = readFileSync(source)
  if (args.includes("-o")) writeFileSync(args[args.indexOf("-o") + 1], content)
  else process.stdout.write(content)
  process.exit(0)
}
if (url === "https://api.github.com/repos/tscircuit/tscircuit-standalone/releases?per_page=1") {
  if (process.env.FIXTURE_METADATA_FAILURE) process.exit(22)
  writeFileSync(args[args.indexOf("-o") + 1], process.env.FIXTURE_METADATA ?? JSON.stringify([
    { tag_name: process.env.FIXTURE_TAG, draft: false, prerelease: true },
  ]))
  process.exit(0)
}
if (!url?.startsWith("https://github.com/tscircuit/tscircuit-standalone/releases/download/" + process.env.FIXTURE_TAG + "/")) process.exit(22)
copyFileSync(process.env.FIXTURE_RELEASE + "/" + url.split("/").at(-1), args[args.indexOf("-o") + 1])
`)
  for (const name of ["uname", "curl"]) await chmod(join(bin, name), 0o755)
  const installerCalls = join(root, "installer-calls")
  await writeFile(installerCalls, "")
  // Never run privileged installation in tests: record and simulate these tools.
  for (const name of ["pkgutil", "spctl", "sudo", "installer"]) {
    await writeFile(join(bin, name), `#!${process.execPath}\n` + String.raw`
import { appendFileSync, readFileSync } from "node:fs"
import { basename } from "node:path"
const tool = basename(process.argv[1])
const args = process.argv.slice(2)
appendFileSync(process.env.FIXTURE_INSTALLER_CALLS, JSON.stringify({ tool, args }) + "\n")
if (process.env.FIXTURE_FAIL_TOOL === tool) process.exit(1)
if (tool === "pkgutil") {
  console.log("Status: signed by a certificate trusted by macOS\n1. " +
    (process.env.FIXTURE_SIGNER ?? "Developer ID Installer: tscircuit Inc. (WUQ9WUY75Z)"))
}
if (tool === "sudo") process.exit(1)
if (tool === "installer") {
  if (args.length !== 4 || args[0] !== "-pkg" || args[2] !== "-target" || args[3] !== "CurrentUserHomeDirectory") process.exit(1)
  if (readFileSync(args[1], "utf8") !== "Fixture signed installer\n") process.exit(1)
}
`)
    await chmod(join(bin, name), 0o755)
  }
  // macOS exercises the real system parser; Linux CI supplies its boundary stub.
  if (process.platform !== "darwin") {
    await writeFile(join(bin, "plutil"), `#!${process.execPath}\n` + String.raw`
import { readFileSync } from "node:fs"
try {
  const tag = JSON.parse(readFileSync(process.argv.at(-1), "utf8"))[0]?.tag_name
  if (typeof tag !== "string") process.exit(1)
  console.log(tag)
} catch { process.exit(1) }
`)
    await chmod(join(bin, "plutil"), 0o755)
  }
  const calls = join(root, "curl-calls")
  await writeFile(calls, "")
  const destination = join(root, "installed tsci")
  const runCommand = (command: string[], env: Record<string, string> = {}) =>
    Bun.spawnSync(command, {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        TSCI_NONINTERACTIVE: "1",
        PATH: `${bin}:/usr/bin:/bin`,
        TMPDIR: temporary,
        FIXTURE_RELEASE: release,
        FIXTURE_CALLS: calls,
        FIXTURE_TAG: releaseTag,
        FIXTURE_INSTALLER: installer,
        FIXTURE_ENTRY: resolve(import.meta.dir, "../scripts/install.sh"),
        FIXTURE_INSTALLER_CALLS: installerCalls,
        ...env,
      },
    })
  const run = (args = [releaseTag, destination], env: Record<string, string> = {}) =>
    runCommand(["/bin/sh", installer, ...args], env)
  const tools = async () => (await readFile(installerCalls, "utf8")).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { tool: string; args: string[] })
  const terminalEnvironment = {
    ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: temporary,
    TSCI_NONINTERACTIVE: "0", FIXTURE_RELEASE: release, FIXTURE_CALLS: calls,
    FIXTURE_TAG: releaseTag, FIXTURE_INSTALLER: installer,
    FIXTURE_ENTRY: resolve(import.meta.dir, "../scripts/install.sh"), FIXTURE_INSTALLER_CALLS: installerCalls,
  }
  return { root, release, archive, pkg, pkgHash, manifest, destination, files, run, runCommand, tools, calls, temporary, terminalEnvironment }
}

for (const architecture of ["arm64", "x86_64"]) {
  test(`installer selects ${architecture}, checks its checksum and preserves notices`, async () => {
    const f = await fixture(architecture)
    const result = f.run()
    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
    for (const [name, content] of Object.entries(f.files)) expect(await readFile(join(f.destination, name), "utf8")).toBe(content)
    expect((await stat(join(f.destination, "tsci"))).mode & 0o111).not.toBe(0)
    const execution = Bun.spawnSync([join(f.destination, "tsci"), "--version"])
    expect(execution.exitCode).toBe(0)
    expect(execution.stdout.toString()).toBe("fixture version\n")
    expect(await readFile(f.calls, "utf8")).toContain(`/${f.archive}\n`)
    expect(await Array.fromAsync(new Bun.Glob("*").scan(f.temporary))).toEqual([])
  })
}

test("a pinned release installs the signed package for the current user", async () => {
  const f = await fixture()
  const result = f.run(["daily-2026-10-15"])
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain(`Run: "${f.root}/.local/bin/tsci" --version`)
  expect((await f.tools()).map(({ tool }) => tool)).toEqual(["pkgutil", "spctl", "installer"])
  expect(await readFile(f.calls, "utf8")).not.toContain("api.github.com")
})

for (const architecture of ["arm64", "x86_64"]) {
  test(`no arguments install the latest published prerelease for ${architecture}`, async () => {
    const tag = "manual-2026-10-23-1234"
    const f = await fixture(architecture, tag)
    const result = f.run([])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain(`Run: "${f.root}/.local/bin/tsci" --version`)
    expect((await f.tools()).map(({ tool }) => tool)).toEqual(["pkgutil", "spctl", "installer"])
    expect((await f.tools()).at(-1)?.args).toEqual(["-pkg", expect.stringContaining(f.pkg), "-target", "CurrentUserHomeDirectory"])
    expect((await readFile(f.calls, "utf8")).trim().split("\n")).toEqual([
      "https://api.github.com/repos/tscircuit/tscircuit-standalone/releases?per_page=1",
      `https://github.com/tscircuit/tscircuit-standalone/releases/download/${tag}/${f.pkg}`,
      `https://github.com/tscircuit/tscircuit-standalone/releases/download/${tag}/SHA256SUMS`,
    ])
    expect(await Array.fromAsync(new Bun.Glob("tscircuit-standalone-*").scan(f.root))).toEqual([])
    expect(await Array.fromAsync(new Bun.Glob("*").scan(f.temporary))).toEqual([])
  })
}

test("the README curl command installs the latest release without arguments", async () => {
  const f = await fixture()
  const readme = await readFile(resolve(import.meta.dir, "../README.md"), "utf8")
  const command = readme.match(/^curl .*\/scripts\/install\.sh \| sh$/m)?.[0]
  expect(command).toBeDefined()
  expect(f.runCommand(["/bin/sh", "-c", command!]).exitCode).toBe(0)
  expect((await f.tools()).at(-1)?.tool).toBe("installer")
})

test("latest accepts a custom destination", async () => {
  const f = await fixture()
  expect(f.run(["latest", f.destination]).exitCode).toBe(0)
  expect(await Bun.file(join(f.destination, "tsci")).exists()).toBe(true)
  expect(await f.tools()).toEqual([])
})

for (const answer of ["custom", "default"]) {
  test.skipIf(process.platform === "win32")(`macOS curl pipeline accepts the ${answer} destination from the terminal`, async () => {
    const f = await fixture()
    const result = await runInstallerInTerminal(
      ["/bin/sh", "-c", "curl -fsSL https://raw.githubusercontent.com/tscircuit/tscircuit-standalone/main/scripts/install.sh | sh"],
      f.root, f.terminalEnvironment, "Portable destination (", answer === "custom" ? f.destination : "",
    )
    expect(result.answered, result.output).toBe(true)
    expect(result.exitCode, result.output).toBe(0)
    if (answer === "custom") {
      expect(await Bun.file(join(f.destination, "tsci")).exists()).toBe(true)
      expect(await f.tools()).toEqual([])
    } else {
      expect((await f.tools()).map(({ tool }) => tool)).toEqual(["pkgutil", "spctl", "installer"])
    }
  })
}

test("macOS rejects an unwritable destination without downloading or requesting administrator access", async () => {
  const f = await fixture()
  const blocked = join(f.root, "blocked")
  await mkdir(blocked)
  await chmod(blocked, 0o555)
  try {
    const result = f.run(["latest", join(blocked, "custom destination")])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("Choose a writable destination")
    expect(await f.tools()).toEqual([])
    expect(await readFile(f.calls, "utf8")).toBe("")
  } finally {
    await chmod(blocked, 0o755)
  }
})

test("per-user installation rejects a changed package before verification or installation", async () => {
  const f = await fixture()
  await writeFile(join(f.release, f.pkg), "Changed installer")
  expect(f.run([]).exitCode).not.toBe(0)
  expect(await f.tools()).toEqual([])
  expect(await Array.fromAsync(new Bun.Glob("*").scan(f.temporary))).toEqual([])
})

test("an unexpected installer signer cannot reach installation", async () => {
  const f = await fixture()
  expect(f.run([], { FIXTURE_SIGNER: "Developer ID Installer: Another Company (OTHERTEAM1)" }).exitCode).not.toBe(0)
  expect((await f.tools()).map(({ tool }) => tool)).toEqual(["pkgutil"])
})

test("signature, Gatekeeper and installation failures cannot report success", async () => {
  for (const tool of ["pkgutil", "spctl", "installer"]) {
    const f = await fixture()
    const result = f.run([], { FIXTURE_FAIL_TOOL: tool })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout.toString()).not.toContain("Installed tsci.")
    const tools = (await f.tools()).map(({ tool }) => tool)
    expect(tools.at(-1)).toBe(tool)
    expect(tools).not.toContain("sudo")
    expect(await Array.fromAsync(new Bun.Glob("*").scan(f.temporary))).toEqual([])
  }
})

test("missing, malformed and unsafe latest release metadata fail before asset downloads", async () => {
  for (const metadata of ["[]", "not JSON", "[{}]", '[{"tag_name":123}]', '[{"tag_name":"../other"}]', '[{"tag_name":""}]']) {
    const f = await fixture()
    expect(f.run([], { FIXTURE_METADATA: metadata }).exitCode).not.toBe(0)
    expect((await readFile(f.calls, "utf8")).trim().split("\n")).toHaveLength(1)
    expect(await Array.fromAsync(new Bun.Glob("*").scan(f.temporary))).toEqual([])
    expect(await Array.fromAsync(new Bun.Glob("tscircuit-standalone-*").scan(f.root))).toEqual([])
  }
})

test("latest metadata download failure cannot install a binary", async () => {
  const f = await fixture()
  expect(f.run([], { FIXTURE_METADATA_FAILURE: "1" }).exitCode).not.toBe(0)
  expect((await readFile(f.calls, "utf8")).trim().split("\n")).toHaveLength(1)
  expect(await Array.fromAsync(new Bun.Glob("*").scan(f.temporary))).toEqual([])
})

test("latest leaves an existing destination untouched", async () => {
  const f = await fixture()
  await mkdir(f.destination)
  await writeFile(join(f.destination, "tsci"), "existing binary")
  expect(f.run(["latest", f.destination]).exitCode).not.toBe(0)
  expect(await readFile(join(f.destination, "tsci"), "utf8")).toBe("existing binary")
  expect(await readFile(f.calls, "utf8")).toBe("")
})

test("latest still rejects a checksum mismatch", async () => {
  const f = await fixture()
  await writeFile(join(f.release, "SHA256SUMS"), f.manifest.replace(/^[a-f0-9]{64}/, "0".repeat(64)))
  expect(f.run(["latest", f.destination]).exitCode).not.toBe(0)
  expect(await Bun.file(join(f.destination, "tsci")).exists()).toBe(false)
  expect(await Array.fromAsync(new Bun.Glob("*").scan(f.temporary))).toEqual([])
})

test("bad, missing and duplicate checksums cannot install a binary", async () => {
  for (const checksum of ["bad", "missing", "duplicate"]) {
    const f = await fixture()
    const manifest = checksum === "bad" ? f.manifest.replace(/^[a-f0-9]{64}/, "0".repeat(64)) : checksum === "missing" ? "" : f.manifest + f.manifest
    await writeFile(join(f.release, "SHA256SUMS"), manifest)
    expect(f.run().exitCode).not.toBe(0)
    expect(await Bun.file(join(f.destination, "tsci")).exists()).toBe(false)
    expect(await Array.fromAsync(new Bun.Glob("*").scan(f.temporary))).toEqual([])
  }
})

test("download failure cannot install a binary", async () => {
  const f = await fixture()
  expect(f.run(undefined, { FIXTURE_DOWNLOAD_FAILURE: "1" }).exitCode).not.toBe(0)
  expect(await Bun.file(join(f.destination, "tsci")).exists()).toBe(false)
})

test("existing installations are left untouched without downloading", async () => {
  const f = await fixture()
  await mkdir(f.destination)
  await writeFile(join(f.destination, "tsci"), "existing binary")
  expect(f.run().exitCode).not.toBe(0)
  expect(await readFile(join(f.destination, "tsci"), "utf8")).toBe("existing binary")
  expect(await readFile(f.calls, "utf8")).toBe("")
})

test("unsupported platforms and unsafe tags fail before downloading", async () => {
  const f = await fixture("riscv64")
  expect(f.run().exitCode).not.toBe(0)
  expect(f.run(undefined, { FIXTURE_OS: "Linux" }).exitCode).not.toBe(0)
  for (const tag of ["../other", "--option", "tag;command", ""]) expect(f.run([tag]).exitCode).not.toBe(0)
  expect(f.run([]).exitCode).not.toBe(0)
  expect(await readFile(f.calls, "utf8")).toBe("")
})
