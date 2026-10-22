import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

// No credentials or Apple connections: exercise the real shell's sequencing,
// rejection handling and cleanup using fixture versions of Apple's commands.
const appleStub =
  `#!${process.execPath}\n` +
  String.raw`
import { appendFileSync, writeFileSync } from "node:fs"
import { basename } from "node:path"
const command = basename(process.argv[1])
const args = process.argv.slice(2)
const failure = process.env.SIGNING_FAILURE
appendFileSync(process.env.SIGNING_CALLS, JSON.stringify([command, ...args]) + "\n")
if (command === "uname") console.log("Darwin")
else if (command === "security") {
  if (args[0] === "list-keychains" && !args.includes("-s")) console.log('    "/Users/fixture/Library/Keychains/login.keychain-db"\n    "/Users/fixture/Shared Keychains/shared.keychain-db"')
  if (args[0] === "import" && failure === "import") process.exit(1)
  if (args[0] === "find-identity") console.log('  1) ' + 'A'.repeat(40) + ' "Developer ID Application: tscircuit Inc. (' + (failure === "team" ? "WRONGTEAM1" : "WUQ9WUY75Z") + ')"')
} else if (command === "curl") {
  writeFileSync(args[args.indexOf("-o") + 1], "Public intermediate")
} else if (command === "codesign") {
  if (args.includes("--sign")) appendFileSync(args.at(-1), "\nDeveloper ID signed\n")
  if (args.includes("--display")) process.stderr.write("TeamIdentifier=WUQ9WUY75Z\nAuthority=Developer ID Application: tscircuit Inc. (WUQ9WUY75Z)\nCodeDirectory flags=0x10000(runtime)\nTimestamp=Oct 22, 2026\n")
  if (failure === "verification" && args.includes("--check-notarization")) process.exit(1)
} else if (command === "ditto") {
  writeFileSync(args.at(-1), "ZIP fixture")
} else if (command === "xcrun") {
  if (args[1] === "submit") {
    console.log(JSON.stringify({id:"11111111-2222-3333-4444-555555555555", status: "In Progress"}))
    if (failure === "upload") process.exit(75)
  } else if (args[1] === "log") writeFileSync(args.at(-1), JSON.stringify({issues:[]}))
  else throw new Error("Unexpected notary command")
} else throw new Error("Unexpected fixture command")
`

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "tsci-signing-test-"))
  roots.push(root)
  const bin = join(root, "bin")
  await mkdir(bin)
  for (const name of [
    "uname",
    "security",
    "curl",
    "codesign",
    "ditto",
    "xcrun",
  ]) {
    await writeFile(join(bin, name), appleStub)
    await chmod(join(bin, name), 0o755)
  }
  const binary = join(root, "tsci")
  const calls = join(root, "calls.jsonl")
  await writeFile(binary, "Fixture executable")
  await writeFile(calls, "")
  const run = (env: Record<string, string> = {}) =>
    Bun.spawnSync(
      [
        "/bin/bash",
        new URL("../scripts/sign-macos.sh", import.meta.url).pathname,
        binary,
      ],
      {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          RUNNER_TEMP: root,
          SIGNING_CALLS: calls,
          MACOS_CERTIFICATE_P12_BASE64:
            Buffer.from("fixture-p12").toString("base64"),
          MACOS_CERTIFICATE_PASSWORD: "fixture-password",
          APPLE_NOTARY_KEY_P8_BASE64:
            Buffer.from("fixture-p8").toString("base64"),
          APPLE_NOTARY_KEY_ID: "FIXTUREKEY",
          APPLE_NOTARY_ISSUER_ID: "fixture-issuer",
          APPLE_TEAM_ID: "WUQ9WUY75Z",
          ...env,
        },
      },
    )
  return {
    root,
    binary,
    run,
    calls: async () =>
      (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    receiptExists: () => Bun.file(`${binary}.notarization.json`).exists(),
  }
}

test("submission returns without waiting, records the signed bytes and removes private material", async () => {
  const signing = await fixture()
  const result = signing.run()
  expect(result.exitCode).toBe(0)
  const receipt = await Bun.file(`${signing.binary}.notarization.json`).json()
  expect(receipt).toEqual({
    id: "11111111-2222-3333-4444-555555555555",
    status: "In Progress",
    teamId: "WUQ9WUY75Z",
    sha256: createHash("sha256")
      .update(await readFile(signing.binary))
      .digest("hex"),
  })
  const calls = await signing.calls()
  const codesign = calls.find(
    (call) => call[0] === "codesign" && call.includes("--sign"),
  )!
  expect(codesign).toContain("--timestamp")
  expect(codesign[codesign.indexOf("--options") + 1]).toBe("runtime")
  expect(
    calls.some(
      (call) =>
        call.includes("--check-notarization") && call.includes("-R=notarized"),
    ),
  ).toBe(false)
  const submission = calls.find((call) => call[0] === "xcrun" && call[2] === "submit")!
  expect(submission).not.toContain("--wait")
  expect(submission).not.toContain("--timeout")
  expect(calls.at(-1)?.slice(0, 2)).toEqual(["security", "delete-keychain"])
  const searchLists = calls.filter(
    (call) =>
      call[0] === "security" &&
      call[1] === "list-keychains" &&
      call.includes("-s"),
  )
  expect(searchLists).toHaveLength(2)
  expect(searchLists.at(-1)?.slice(5)).toEqual([
    "/Users/fixture/Library/Keychains/login.keychain-db",
    "/Users/fixture/Shared Keychains/shared.keychain-db",
  ])
  expect(
    (await readdir(signing.root)).some((name) =>
      name.startsWith("tsci-signing."),
    ),
  ).toBe(false)
})

test("missing credentials fail before importing any identity", async () => {
  const signing = await fixture()
  expect(signing.run({ MACOS_CERTIFICATE_PASSWORD: "" }).exitCode).not.toBe(0)
  expect((await signing.calls()).some((call) => call[0] === "security")).toBe(
    false,
  )
  expect(await signing.receiptExists()).toBe(false)
})

test("a failed upload removes a previous submission receipt", async () => {
  const signing = await fixture()
  expect(signing.run().exitCode).toBe(0)
  expect(await signing.receiptExists()).toBe(true)
  expect(signing.run({ SIGNING_FAILURE: "upload" }).exitCode).not.toBe(0)
  expect(await signing.receiptExists()).toBe(false)
})

test("import failures, wrong teams and failed uploads cannot produce a submission receipt", async () => {
  for (const failure of [
    "import",
    "team",
    "upload",
  ]) {
    const signing = await fixture()
    const result = signing.run({ SIGNING_FAILURE: failure })
    expect(result.exitCode).not.toBe(0)
    expect(await signing.receiptExists()).toBe(false)
    const calls = await signing.calls()
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["security", "delete-keychain"])
    expect(
      (await readdir(signing.root)).some((name) =>
        name.startsWith("tsci-signing."),
      ),
    ).toBe(false)
    if (["import", "team"].includes(failure)) {
      expect(calls.some((call) => call[0] === "xcrun")).toBe(false)
    }
  }
}, 30_000)

test("only accepted releases reach native verification and publication", async () => {
  const load = async (file: string) => Bun.YAML.parse(
    await Bun.file(new URL("../.github/workflows/" + file, import.meta.url)).text(),
  ) as any
  const daily = await load("daily-release.yml")
  const finalizer = await load("finalize-release.yml")
  const checker = await load("check-notarization.yml")
  const manual = await load("manual-release.yml")
  expect(daily.jobs.stage.needs).toContain("sign-macos")
  expect(daily.jobs.publish).toBeUndefined()
  expect(finalizer.jobs.publish.needs).toContain("verify-macos")
  expect(finalizer.jobs["verify-macos"].if).toBe("needs.inspect.outputs.ready == 'true'")
  expect(checker.jobs.finalize.uses).toBe("./.github/workflows/finalize-release.yml")
  expect(manual.jobs.release.secrets).toBe("inherit")
  expect(JSON.stringify(checker)).not.toContain("MACOS_CERTIFICATE")
  expect(JSON.stringify(finalizer)).not.toContain("MACOS_CERTIFICATE")
  const ci = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text()
  expect(ci).not.toContain("secrets.")
})
