import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

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
  const manifest = `${hash}  ${archive}\n${"0".repeat(64)}  tscircuit-standalone-linux-x64.tar.gz\n`
  await writeFile(join(release, "SHA256SUMS"), manifest)
  await writeFile(join(bin, "uname"), `#!/bin/sh\nif [ "$1" = -s ]; then printf '%s\\n' "\${FIXTURE_OS:-Darwin}"; else printf '%s\\n' '${architecture}'; fi\n`)
  // Serve the official script, release metadata and assets without network access.
  await writeFile(join(bin, "curl"), `#!${process.execPath}\n` + String.raw`
import { copyFileSync, appendFileSync, readFileSync, writeFileSync } from "node:fs"
const args = process.argv.slice(2)
const url = args.find((arg) => arg.startsWith("https://"))
appendFileSync(process.env.FIXTURE_CALLS, url + "\n")
if (process.env.FIXTURE_DOWNLOAD_FAILURE) process.exit(22)
if (url === "https://raw.githubusercontent.com/tscircuit/tscircuit-standalone/main/scripts/install-macos.sh") {
  process.stdout.write(readFileSync(process.env.FIXTURE_INSTALLER))
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
        PATH: `${bin}:/usr/bin:/bin`,
        TMPDIR: temporary,
        FIXTURE_RELEASE: release,
        FIXTURE_CALLS: calls,
        FIXTURE_TAG: releaseTag,
        FIXTURE_INSTALLER: installer,
        ...env,
      },
    })
  const run = (args = [releaseTag, destination], env: Record<string, string> = {}) =>
    runCommand(["/bin/sh", installer, ...args], env)
  return { root, release, archive, manifest, destination, files, run, runCommand, calls, temporary }
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

test("installer uses a release-specific default destination", async () => {
  const f = await fixture()
  expect(f.run(["daily-2026-10-15"]).exitCode).toBe(0)
  expect(await Bun.file(join(f.root, "tscircuit-standalone-daily-2026-10-15/tsci")).exists()).toBe(true)
})

for (const architecture of ["arm64", "x86_64"]) {
  test(`no arguments install the latest published prerelease for ${architecture}`, async () => {
    const tag = "manual-2026-10-23-1234"
    const f = await fixture(architecture, tag)
    const result = f.run([])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain(`tscircuit-standalone-${tag}/tsci`)
    expect(await Bun.file(join(f.root, `tscircuit-standalone-${tag}/tsci`)).exists()).toBe(true)
    expect((await readFile(f.calls, "utf8")).trim().split("\n")).toEqual([
      "https://api.github.com/repos/tscircuit/tscircuit-standalone/releases?per_page=1",
      `https://github.com/tscircuit/tscircuit-standalone/releases/download/${tag}/${f.archive}`,
      `https://github.com/tscircuit/tscircuit-standalone/releases/download/${tag}/SHA256SUMS`,
    ])
    expect(await Array.fromAsync(new Bun.Glob("*").scan(f.temporary))).toEqual([])
  })
}

test("the README curl command installs the latest release without arguments", async () => {
  const f = await fixture()
  const readme = await readFile(resolve(import.meta.dir, "../README.md"), "utf8")
  const command = readme.match(/^curl .*\/scripts\/install-macos\.sh \| sh$/m)?.[0]
  expect(command).toBeDefined()
  expect(f.runCommand(["/bin/sh", "-c", command!]).exitCode).toBe(0)
  expect(await Bun.file(join(f.root, "tscircuit-standalone-daily-2026-10-15/tsci")).exists()).toBe(true)
})

test("latest accepts a custom destination", async () => {
  const f = await fixture()
  expect(f.run(["latest", f.destination]).exitCode).toBe(0)
  expect(await Bun.file(join(f.destination, "tsci")).exists()).toBe(true)
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
  expect((await readFile(f.calls, "utf8")).trim().split("\n")).toHaveLength(1)
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
