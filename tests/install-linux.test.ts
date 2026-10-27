import { afterEach, expect, test } from "bun:test"
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const project = resolve(import.meta.dir, "..")
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const fixture = async (architecture = "x86_64") => {
  const root = await mkdtemp(join(tmpdir(), "tsci-linux-installer-"))
  directories.push(root)
  const bin = join(root, "bin"), release = join(root, "release"), payload = join(root, "payload")
  const temporary = join(root, "temporary"), prefix = join(root, "prefix"), calls = join(root, "calls")
  for (const path of [bin, release, payload, temporary, join(prefix, "bin")]) await mkdir(path, { recursive: true })
  await writeFile(calls, "")
  const archive = `tscircuit-standalone-linux-${architecture === "x86_64" ? "x64" : "arm64"}.tar.gz`
  const commandPath = join(prefix, "bin/tsci")
  const prepare = async (version = "1", executable = true) => {
    await writeFile(join(payload, "tsci"), `#!/bin/sh\nprintf 'fixture ${version}\\n'\n`)
    await chmod(join(payload, "tsci"), executable ? 0o755 : 0o644)
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES", "licenses.json", "THIRD_PARTY_NOTICES.txt"])
      await writeFile(join(payload, name), "fixture notice")
    const result = Bun.spawnSync(["tar", "-czf", join(release, archive), "-C", payload,
      "tsci", "LICENSE", "THIRD_PARTY_NOTICES", "licenses.json", "THIRD_PARTY_NOTICES.txt"])
    expect(result.exitCode).toBe(0)
    const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(join(release, archive)).arrayBuffer()).digest("hex")
    await writeFile(join(release, "SHA256SUMS"), `${digest}  ${archive}\n`)
  }
  await prepare()
  await writeFile(join(bin, "uname"), `#!/bin/sh\nif [ "$1" = -s ]; then echo "\${FIXTURE_OS:-Linux}"; else echo "\${FIXTURE_ARCH:-${architecture}}"; fi\n`)
  await writeFile(join(bin, "curl"), `#!${process.execPath}\n` + String.raw`
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs"
const args = process.argv.slice(2)
const url = args.find(arg => arg.startsWith("https://"))
appendFileSync(process.env.FIXTURE_CALLS, url + "\n")
if (process.env.FIXTURE_DOWNLOAD_FAILURE) process.exit(22)
let bytes
if (url === "https://raw.githubusercontent.com/tscircuit/tscircuit-standalone/main/scripts/install.sh")
  bytes = readFileSync(process.env.FIXTURE_PROJECT + "/scripts/install.sh")
else if (url === "https://raw.githubusercontent.com/tscircuit/tscircuit-standalone/main/scripts/install-linux.sh")
  bytes = readFileSync(process.env.FIXTURE_PROJECT + "/scripts/install-linux.sh")
else if (url === "https://api.github.com/repos/tscircuit/tscircuit-standalone/releases?per_page=1")
  bytes = process.env.FIXTURE_METADATA ?? JSON.stringify([{ tag_name: "daily-2026-10-27", draft: false }])
else if (url?.startsWith("https://github.com/tscircuit/tscircuit-standalone/releases/download/daily-2026-10-27/")) {
  bytes = readFileSync(process.env.FIXTURE_RELEASE + "/" + url.split("/").at(-1))
  if (process.env.FIXTURE_CREATE_CONFLICT && url.endsWith(".tar.gz"))
    writeFileSync(process.env.FIXTURE_COMMAND, "existing npm command")
  if (process.env.FIXTURE_CREATE_PATH_CONFLICT && url.endsWith(".tar.gz")) {
    writeFileSync(process.env.FIXTURE_PATH_COMMAND, "#!/bin/sh\nprintf 'npm version\\n'\n")
    chmodSync(process.env.FIXTURE_PATH_COMMAND, 0o755)
  }
} else process.exit(22)
if (args.includes("-o")) writeFileSync(args[args.indexOf("-o") + 1], bytes)
else process.stdout.write(bytes)
`)
  await chmod(join(bin, "uname"), 0o755)
  await chmod(join(bin, "curl"), 0o755)
  const environment = (extra: Record<string, string> = {}) => ({
    ...process.env, PATH: `${join(prefix, "bin")}:${bin}:/usr/bin:/bin`, TMPDIR: temporary,
    TSCI_INSTALL_PREFIX: prefix, FIXTURE_CALLS: calls, FIXTURE_PROJECT: project,
    FIXTURE_RELEASE: release, FIXTURE_COMMAND: commandPath, FIXTURE_PATH_COMMAND: join(bin, "tsci"), ...extra,
  })
  const run = (args: string[] = [], extra: Record<string, string> = {}) => Bun.spawnSync(
    ["/bin/sh", join(project, "scripts/install-linux.sh"), ...args], { cwd: root, env: environment(extra) },
  )
  const bundles = async () => readdir(join(prefix, "lib/tscircuit-standalone")).catch(() => [])
  return { root, bin, release, payload, temporary, prefix, calls, archive, commandPath, prepare, run, bundles, environment }
}

for (const architecture of ["x86_64", "aarch64"]) {
  test(`Linux installer selects ${architecture}, installs on PATH and retains licenses`, async () => {
    const f = await fixture(architecture)
    const result = f.run()
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const installed = Bun.spawnSync(["tsci", "--version"], { cwd: tmpdir(), env: f.environment() })
    expect(installed.stdout.toString()).toBe("fixture 1\n")
    const bundle = resolve(f.commandPath, "..", await readlink(f.commandPath), "..")
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES", "licenses.json", "THIRD_PARTY_NOTICES.txt"])
      expect(await readFile(join(bundle, name), "utf8")).toBe("fixture notice")
    expect(await readdir(f.temporary)).toEqual([])
  })
}

test("the documented shared curl command installs on Linux without Bun/Node being used by the installer", async () => {
  const f = await fixture()
  const readme = await readFile(join(project, "README.md"), "utf8")
  const command = readme.match(/^curl .*\/scripts\/install\.sh \| sh$/m)?.[0]
  expect(command).toBeDefined()
  const result = Bun.spawnSync(["/bin/sh", "-c", command!], { cwd: f.root, env: f.environment() })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect((await readFile(f.calls, "utf8")).split("\n").slice(0, 2)).toEqual([
    "https://raw.githubusercontent.com/tscircuit/tscircuit-standalone/main/scripts/install.sh",
    "https://raw.githubusercontent.com/tscircuit/tscircuit-standalone/main/scripts/install-linux.sh",
  ])
  expect(await readdir(f.temporary)).toEqual([])
})

test("Linux latest resolution also works with Python 3 when jq is absent", async () => {
  const f = await fixture()
  for (const tool of ["sh", "tar", "gzip", "mktemp", "rm", "dirname", "id", "readlink", "grep", "awk", "mkdir", "cp", "chmod", "ln", "mv", "sha256sum", "shasum", "python3"]) {
    const path = Bun.which(tool)
    if (path) await symlink(path, join(f.bin, tool))
  }
  const result = f.run([], { PATH: f.bin })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
})

test("Linux upgrades replace only the managed bundle and clean up the previous binary", async () => {
  const f = await fixture()
  expect(f.run().exitCode).toBe(0)
  const old = await readlink(f.commandPath)
  await f.prepare("2")
  expect(f.run().exitCode).toBe(0)
  expect(await readlink(f.commandPath)).not.toBe(old)
  expect(await Bun.file(old).exists()).toBe(false)
  expect(await f.bundles()).toHaveLength(1)
  expect(Bun.spawnSync([f.commandPath, "--version"]).stdout.toString()).toBe("fixture 2\n")
})

test("Linux installs readable licenses and executable directories with a restrictive caller umask", async () => {
  const f = await fixture()
  const result = Bun.spawnSync(["/bin/sh", "-c", 'umask 077; exec /bin/sh "$1"', "fixture", join(project, "scripts/install-linux.sh")], {
    cwd: f.root, env: f.environment(),
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  const binary = await readlink(f.commandPath)
  expect((await stat(join(f.prefix, "lib/tscircuit-standalone"))).mode & 0o777).toBe(0o755)
  expect((await stat(resolve(binary, ".."))).mode & 0o777).toBe(0o755)
  expect((await stat(binary)).mode & 0o777).toBe(0o755)
  expect((await stat(resolve(binary, "../LICENSE"))).mode & 0o777).toBe(0o644)
})

test("Linux preserves an existing npm command, including one created during downloading", async () => {
  const f = await fixture()
  await writeFile(f.commandPath, "existing npm command")
  expect(f.run().exitCode).not.toBe(0)
  expect(await readFile(f.commandPath, "utf8")).toBe("existing npm command")
  expect(await readFile(f.calls, "utf8")).toBe("")
  await rm(f.commandPath)
  expect(f.run([], { FIXTURE_CREATE_CONFLICT: "1" }).exitCode).not.toBe(0)
  expect(await readFile(f.commandPath, "utf8")).toBe("existing npm command")
  expect(await f.bundles()).toEqual([])
})

test("a failed Linux upgrade keeps the previous command and removes the new staging files", async () => {
  const f = await fixture()
  expect(f.run().exitCode).toBe(0)
  const old = await readlink(f.commandPath)
  await writeFile(join(f.bin, "mv"), '#!/bin/sh\nexit 1\n')
  await chmod(join(f.bin, "mv"), 0o755)
  expect(f.run().exitCode).not.toBe(0)
  expect(await readlink(f.commandPath)).toBe(old)
  expect(await f.bundles()).toHaveLength(1)
  expect(await readdir(f.temporary)).toEqual([])
})

test("Linux preserves an npm command elsewhere on PATH", async () => {
  const f = await fixture()
  const npmCommand = join(f.bin, "tsci")
  await writeFile(npmCommand, "#!/bin/sh\nprintf 'npm version\\n'\n")
  await chmod(npmCommand, 0o755)
  expect(f.run().exitCode).not.toBe(0)
  expect(await readFile(f.calls, "utf8")).toBe("")
  expect(await Bun.file(f.commandPath).exists()).toBe(false)
  expect(Bun.spawnSync([npmCommand]).stdout.toString()).toBe("npm version\n")
  await rm(npmCommand)
  expect(f.run([], { FIXTURE_CREATE_PATH_CONFLICT: "1" }).exitCode).not.toBe(0)
  expect(await Bun.file(f.commandPath).exists()).toBe(false)
  expect(Bun.spawnSync([npmCommand]).stdout.toString()).toBe("npm version\n")
  expect(await f.bundles()).toEqual([])
})

test("Linux rejects changed, duplicate and missing checksums before installation", async () => {
  const f = await fixture()
  const sums = await readFile(join(f.release, "SHA256SUMS"), "utf8")
  for (const manifest of [sums.replace(/^[a-f0-9]{64}/, "0".repeat(64)), sums + sums, ""]) {
    await writeFile(join(f.release, "SHA256SUMS"), manifest)
    expect(f.run().exitCode).not.toBe(0)
    expect(await Bun.file(f.commandPath).exists()).toBe(false)
    expect(await readdir(f.temporary)).toEqual([])
  }
})

test("Linux rejects malformed release metadata, unsafe tags and failed downloads", async () => {
  const f = await fixture()
  for (const metadata of ["invalid", "[]", '{}', '[{"draft":true,"tag_name":"daily-test"}]', '[{"draft":false,"tag_name":"../unsafe"}]', '[{"draft":false,"tag_name":7}]'])
    expect(f.run([], { FIXTURE_METADATA: metadata }).exitCode).not.toBe(0)
  expect(f.run(["../unsafe"]).exitCode).not.toBe(0)
  expect(f.run([], { FIXTURE_DOWNLOAD_FAILURE: "1" }).exitCode).not.toBe(0)
  expect(await Bun.file(f.commandPath).exists()).toBe(false)
  expect(await readdir(f.temporary)).toEqual([])
})

test("Linux supports explicit portable destinations and rejects non-executable payloads", async () => {
  const f = await fixture()
  const destination = join(f.root, "portable")
  expect(f.run(["daily-2026-10-27", destination]).exitCode).toBe(0)
  expect(await Bun.file(join(destination, "tsci")).exists()).toBe(true)
  expect(f.run(["daily-2026-10-27", destination]).exitCode).not.toBe(0)
  await f.prepare("1", false)
  expect(f.run().exitCode).not.toBe(0)
  expect(await Bun.file(f.commandPath).exists()).toBe(false)
})

test("Linux rejects unsupported systems and architectures before downloading", async () => {
  const f = await fixture()
  expect(f.run([], { FIXTURE_OS: "Darwin" }).exitCode).not.toBe(0)
  expect(f.run([], { FIXTURE_ARCH: "i686" }).exitCode).not.toBe(0)
  expect(await readFile(f.calls, "utf8")).toBe("")
})

test.skipIf(process.platform !== "linux" || !process.env.TSCI_TEST_LINUX_ARCHIVE)("the qualified Linux release installs and starts through the shared curl command", async () => {
  const f = await fixture()
  await copyFile(process.env.TSCI_TEST_LINUX_ARCHIVE!, join(f.release, f.archive))
  const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(join(f.release, f.archive)).arrayBuffer()).digest("hex")
  await writeFile(join(f.release, "SHA256SUMS"), `${digest}  ${f.archive}\n`)
  const readme = await readFile(join(project, "README.md"), "utf8")
  const command = readme.match(/^curl .*\/scripts\/install\.sh \| sh$/m)?.[0]
  expect(command).toBeDefined()
  const installed = Bun.spawnSync(["/bin/sh", "-c", command!], { cwd: f.root, env: f.environment() })
  expect(installed.exitCode, installed.stdout.toString() + installed.stderr.toString()).toBe(0)
  const result = Bun.spawnSync(["tsci", "--version"], { cwd: tmpdir(), env: f.environment() })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString().trim()).toBe((await Bun.file(join(project, "package.json")).json()).version)
}, 60_000)
