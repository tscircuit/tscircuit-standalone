import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { packageRelease } from "../scripts/package-release"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "standalone-release-package-"))
  directories.push(root)
  await mkdir(join(root, "dist"))
  const files = {
    "dist/tsci": "#!/bin/sh\nprintf 'fixture binary\\n'\n",
    "dist/tsci.exe": "fixture Windows binary\0\u0001",
    LICENSE: "fixture project license\n",
    THIRD_PARTY_NOTICES: "fixture project notices\n",
    "dist/licenses.json": '{"packages":["fixture"]}\n',
    "dist/THIRD_PARTY_NOTICES.txt": "fixture compiled dependency notices\n",
  }
  for (const [path, content] of Object.entries(files))
    await writeFile(join(root, path), content)
  return { root, files }
}

test("Linux and macOS archives include usable executables and every notice", async () => {
  const { root, files } = await fixture()
  for (const [target, name] of [
    ["bun-linux-x64", "linux-x64"],
    ["bun-linux-arm64", "linux-arm64"],
    ["bun-darwin-x64", "macos-x64"],
    ["bun-darwin-arm64", "macos-arm64"],
  ]) {
    const { archive } = await packageRelease({ projectRoot: root, target })
    expect(basename(archive)).toBe(`tscircuit-standalone-${name}.tar.gz`)
    const extracted = join(root, name!)
    await mkdir(extracted)
    const extraction = Bun.spawnSync(["tar", "-xpzf", archive, "-C", extracted])
    expect(extraction.exitCode).toBe(0)
    expect((await stat(join(extracted, "tsci"))).mode & 0o777).toBe(0o755)
    const execution = Bun.spawnSync([join(extracted, "tsci")])
    expect(execution.exitCode).toBe(0)
    expect(execution.stdout.toString()).toBe("fixture binary\n")
    const contents = Bun.spawnSync(["tar", "-tzf", archive])
      .stdout.toString()
      .trim()
      .split("\n")
    expect(contents.sort()).toEqual(
      [
        "tsci",
        "LICENSE",
        "THIRD_PARTY_NOTICES",
        "licenses.json",
        "THIRD_PARTY_NOTICES.txt",
      ].sort(),
    )
    for (const [path, content] of Object.entries(files).filter(
      ([path]) => !path.endsWith(".exe"),
    )) {
      expect(await readFile(join(extracted, basename(path)), "utf8")).toBe(content)
    }
  }
})

test("Windows ZIP contains the exe and every notice with exact bytes", async () => {
  const { root, files } = await fixture()
  const { archive } = await packageRelease({ projectRoot: root, target: "bun-windows-x64" })
  expect(basename(archive)).toBe("tscircuit-standalone-windows-x64.zip")
  const listing = Bun.spawnSync(["unzip", "-Z1", archive])
  expect(listing.exitCode).toBe(0)
  expect(listing.stdout.toString().trim().split("\n").sort()).toEqual(
    [
      "tsci.exe",
      "LICENSE",
      "THIRD_PARTY_NOTICES",
      "licenses.json",
      "THIRD_PARTY_NOTICES.txt",
    ].sort(),
  )
  for (const [path, content] of Object.entries(files).filter(
    ([path]) => path !== "dist/tsci",
  )) {
    const extracted = Bun.spawnSync(["unzip", "-p", archive, basename(path)])
    expect(extracted.exitCode).toBe(0)
    expect(extracted.stdout.toString()).toBe(content)
  }
})

test("direct downloads preserve binary bytes and include every redistribution file in companion notices", async () => {
  const { root, files } = await fixture()
  for (const platform of [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "windows-x64",
  ]) {
    const windows = platform === "windows-x64"
    const assets = await packageRelease({
      projectRoot: root,
      target: `bun-${platform}`,
    })
    expect(basename(assets.binary)).toBe(`tsci-${platform}${windows ? ".exe" : ""}`)
    expect(basename(assets.notices)).toBe(`tsci-${platform}.notices.txt`)
    expect(await readFile(assets.binary)).toEqual(
      await readFile(join(root, windows ? "dist/tsci.exe" : "dist/tsci")),
    )
    expect((await stat(assets.binary)).mode & 0o777).toBe(windows ? 0o644 : 0o755)
    if (!windows) {
      const execution = Bun.spawnSync([assets.binary])
      expect(execution.exitCode).toBe(0)
      expect(execution.stdout.toString()).toBe("fixture binary\n")
    }
    const notices = await readFile(assets.notices, "utf8")
    for (const [path, content] of Object.entries(files).filter(
      ([path]) => !path.startsWith("dist/tsci"),
    )) {
      expect(notices).toContain(`\n${basename(path)}\n\n${content}`)
    }
    const repeated = await packageRelease({
      projectRoot: root,
      target: `bun-${platform}`,
    })
    expect(await readFile(repeated.notices, "utf8")).toBe(notices)
  }
})

test("packaging rejects missing or empty redistribution files before writing an archive", async () => {
  for (const input of [
    "dist/tsci",
    "LICENSE",
    "THIRD_PARTY_NOTICES",
    "dist/licenses.json",
    "dist/THIRD_PARTY_NOTICES.txt",
  ]) {
    for (const missing of [true, false]) {
      const { root } = await fixture()
      if (missing) await rm(join(root, input))
      else await writeFile(join(root, input), "")
      await expect(
        packageRelease({ projectRoot: root, target: "bun-linux-x64" }),
      ).rejects.toThrow(`Missing or empty release input: ${input}`)
      expect(
        await Bun.file(
          join(root, "dist/release/tscircuit-standalone-linux-x64.tar.gz"),
        ).exists(),
      ).toBe(false)
      expect(
        await Bun.file(join(root, "dist/release/tsci-linux-x64")).exists(),
      ).toBe(false)
      expect(
        await Bun.file(join(root, "dist/release/tsci-linux-x64.notices.txt")).exists(),
      ).toBe(false)
    }
  }
})

test("packaging refuses an unsupported or unspecified target", async () => {
  const { root } = await fixture()
  await expect(
    packageRelease({ projectRoot: root, target: "bun-linux-riscv64" }),
  ).rejects.toThrow("Unsupported binary target")
  await expect(packageRelease({ projectRoot: root, target: "" })).rejects.toThrow(
    "BUN_BUILD_TARGET is required",
  )
})
