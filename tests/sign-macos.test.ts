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
import { appendFileSync, writeFileSync, copyFileSync, readFileSync } from "node:fs"
import { basename } from "node:path"
const command = basename(process.argv[1])
const args = process.argv.slice(2)
const failure = process.env.SIGNING_FAILURE
appendFileSync(process.env.SIGNING_CALLS, JSON.stringify([command, ...args]) + "\n")
if (command === "uname") console.log(args.includes("-m") ? "arm64" : "Darwin")
else if (command === "security") {
  if (args[0] === "list-keychains" && !args.includes("-s")) console.log('    "/Users/fixture/Library/Keychains/login.keychain-db"\n    "/Users/fixture/Shared Keychains/shared.keychain-db"')
  if (args[0] === "import" && failure === "import") process.exit(1)
  if (args[0] === "import" && args[1].endsWith("DeveloperIDG2CA.cer")) {
    if (failure === "included-intermediate") {
      process.stderr.write("security: SecKeychainItemImport: The specified item already exists in the keychain.\n")
      process.exit(1)
    }
    if (failure === "intermediate-error") {
      process.stderr.write("security: public certificate import denied\n")
      process.exit(1)
    }
  }
  if (args[0] === "find-identity") {
    const installer = !args.includes("-p")
    const wrongTeam = failure === "team" || installer && failure === "installer-team"
    console.log('  1) ' + (installer ? 'B' : 'A').repeat(40) + ' "Developer ID ' + (installer ? 'Installer' : 'Application') + ': tscircuit Inc. (' + (wrongTeam ? "WRONGTEAM1" : "WUQ9WUY75Z") + ')"')
  }
} else if (command === "curl") {
  writeFileSync(args[args.indexOf("-o") + 1], "Public intermediate")
} else if (command === "codesign") {
  if (args.includes("--sign")) appendFileSync(args.at(-1), "\nDeveloper ID signed\n")
  if (args.includes("--display")) process.stderr.write("TeamIdentifier=WUQ9WUY75Z\nAuthority=Developer ID Application: tscircuit Inc. (WUQ9WUY75Z)\nCodeDirectory flags=0x10000(runtime)\nTimestamp=Oct 22, 2026\n")
  if (failure === "signature" && args.includes("--verify") && !args.includes("--check-notarization")) process.exit(2)
  if (args.includes("--check-notarization")) {
    process.stderr.write("fixture verbose ticket verification\n")
    if (failure === "verification") process.exit(3)
  }
} else if (command === "log") {
  console.log("fixture notarization system log")
  if (failure === "log") process.exit(99)
} else if (command === "sleep") {
  // Record retry backoff without slowing the fixture down.
} else if (command === "bun") {
  writeFileSync(args.at(-1), "Unsigned installer fixture")
} else if (command === "productsign") {
  if (failure === "installer-signing") process.exit(4)
  copyFileSync(args.at(-2), args.at(-1))
  appendFileSync(args.at(-1), "\nInstaller signed\n")
} else if (command === "pkgutil") {
  console.log("Developer ID Installer: tscircuit Inc. (WUQ9WUY75Z)\nSigned with a trusted timestamp")
  if (failure === "installer-signature") process.exit(5)
} else if (command === "spctl") {
  console.log("accepted, source=Notarized Developer ID")
  if (failure === "gatekeeper") process.exit(6)
} else if (command === "xcrun") {
  if (args[0] === "stapler") {
    const counter = process.env.SIGNING_CALLS + ".stapler-" + args[1]
    let attempt = 1
    try { attempt += Number(readFileSync(counter, "utf8")) } catch {}
    writeFileSync(counter, String(attempt))
    const networkFailure = failure === "staple-network" && args[1] === "staple" && attempt === 1 ||
      failure === "validation-network" && args[1] === "validate" && attempt === 1 ||
      failure === "validation-network-exhausted" && args[1] === "validate"
    if (networkFailure) {
      process.stderr.write('error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\nThe validate action failed! Error 68.\n')
      process.exit(68)
    }
    if (["validation-permanent", "validation-tls"].includes(failure) && args[1] === "validate") {
      process.stderr.write(failure === "validation-tls" ? 'Error Domain=NSURLErrorDomain Code=-1202 "Untrusted certificate"\n' : "Ticket contents are invalid.\n")
      process.exit(68)
    }
    if (failure === "staple") process.exit(7)
    if (args[1] === "staple") appendFileSync(args.at(-1), "\nApple ticket stapled\n")
    if (args[1] === "validate" && failure === "staple-validation") process.exit(8)
    console.log("Stapler succeeded")
  } else if (args[1] === "submit") {
    console.log(JSON.stringify({id:"fixture-submission", status: failure === "rejected" ? "Invalid" : failure === "timeout" ? "In Progress" : "Accepted"}))
    if (failure === "timeout") process.exit(75)
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
    "bun",
    "productsign",
    "pkgutil",
    "spctl",
    "xcrun",
    "log",
    "sleep",
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
          MACOS_INSTALLER_CERTIFICATE_P12_BASE64: Buffer.from("fixture-installer-p12").toString("base64"),
          MACOS_INSTALLER_CERTIFICATE_PASSWORD: "fixture-installer-password",
          RELEASE_VERSION: "0.0.3003",
          MACOS_ARCH: "arm64",
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
    diagnosticFiles: async () => {
      const base = join(root, "signing-diagnostics")
      const attempts = await readdir(base).catch(() => [])
      const files: Record<string, string> = {}
      for (const attempt of attempts) {
        for (const name of await readdir(join(base, attempt)))
          files[name] = await readFile(join(base, attempt, name), "utf8")
      }
      return files
    },
    receiptExists: () => Bun.file(`${binary}.notarization.json`).exists(),
  }
}

test("accepted notarization records the final signed bytes and removes private material", async () => {
  const signing = await fixture()
  const result = signing.run()
  expect(result.exitCode).toBe(0)
  const receipt = await Bun.file(`${signing.binary}.notarization.json`).json()
  const installerReceipt = await Bun.file(`${signing.binary}.pkg.notarization.json`).json()
  expect(installerReceipt).toMatchObject({
    id: "fixture-submission", status: "Accepted", teamId: "WUQ9WUY75Z",
    binarySha256: receipt.sha256, architecture: "arm64", version: "0.0.3003",
    sha256: createHash("sha256").update(await readFile(`${signing.binary}.pkg`)).digest("hex"),
  })
  expect(await readFile(`${signing.binary}.pkg`, "utf8")).toContain("Apple ticket stapled")
  expect(receipt).toEqual({
    id: "fixture-submission",
    status: "Accepted",
    teamId: "WUQ9WUY75Z",
    sha256: createHash("sha256")
      .update(await readFile(signing.binary))
      .digest("hex"),
  })
  const calls = await signing.calls()
  const submissions = calls.filter((call) => call[0] === "xcrun" && call[2] === "submit")
  expect(submissions).toHaveLength(1)
  expect(submissions[0]?.[3]).toBe(`${signing.binary}.pkg`)
  const installerSigning = calls.find((call) => call[0] === "productsign")!
  expect(installerSigning).toContain("--timestamp")
  expect(installerSigning[installerSigning.indexOf("--sign") + 1]).toBe("B".repeat(40))
  expect(calls.findIndex((call) => call[0] === "productsign")).toBeLessThan(calls.indexOf(submissions[0]!))
  expect(calls.findIndex((call) => call[0] === "spctl")).toBeGreaterThan(calls.findIndex((call) => call[0] === "xcrun" && call[2] === "validate"))
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
  ).toBe(true)
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
  for (const name of ["MACOS_CERTIFICATE_PASSWORD", "MACOS_INSTALLER_CERTIFICATE_P12_BASE64", "MACOS_INSTALLER_CERTIFICATE_PASSWORD"])
    expect(signing.run({ [name]: "" }).exitCode).not.toBe(0)
  expect((await signing.calls()).some((call) => call[0] === "security")).toBe(
    false,
  )
  expect(await signing.receiptExists()).toBe(false)
})

test("a failed retry removes a previous acceptance receipt", async () => {
  const signing = await fixture()
  expect(signing.run().exitCode).toBe(0)
  expect(await signing.receiptExists()).toBe(true)
  expect(signing.run({ SIGNING_FAILURE: "rejected" }).exitCode).not.toBe(0)
  expect(await signing.receiptExists()).toBe(false)
  expect(await Bun.file(`${signing.binary}.pkg.notarization.json`).exists()).toBe(false)
})

test("import failures, wrong teams, rejection, timeout and failed ticket verification cannot produce a receipt", async () => {
  for (const failure of [
    "import",
    "team",
    "rejected",
    "timeout",
    "verification",
    "installer-team",
    "installer-signing",
    "installer-signature",
    "staple",
    "staple-validation",
    "gatekeeper",
    "intermediate-error",
  ]) {
    const signing = await fixture()
    const result = signing.run({ SIGNING_FAILURE: failure })
    expect(result.exitCode).not.toBe(0)
    expect(await signing.receiptExists()).toBe(false)
    expect(await Bun.file(`${signing.binary}.pkg.notarization.json`).exists()).toBe(false)
    const calls = await signing.calls()
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["security", "delete-keychain"])
    expect(
      (await readdir(signing.root)).some((name) =>
        name.startsWith("tsci-signing."),
      ),
    ).toBe(false)
    if (["import", "team", "installer-team", "installer-signing", "installer-signature", "intermediate-error"].includes(failure)) {
      expect(calls.some((call) => call[0] === "xcrun")).toBe(false)
    }
  }
}, 30_000)

test("publication waits for every signed platform and manual releases forward secrets", async () => {
  const daily = Bun.YAML.parse(
    await Bun.file(
      new URL("../.github/workflows/daily-release.yml", import.meta.url),
    ).text(),
  ) as any
  const manual = Bun.YAML.parse(
    await Bun.file(
      new URL("../.github/workflows/manual-release.yml", import.meta.url),
    ).text(),
  ) as any
  expect(daily.jobs.publish.needs).toContain("sign-macos")
  expect(daily.jobs.publish.needs).toContain("sign-windows")
  expect(daily.jobs["sign-macos"].needs).toEqual(["prepare", "build"])
  const downloads = daily.jobs.publish.steps.filter(
    (step: any) => step.uses === "actions/download-artifact@v4",
  )
  expect(downloads.map((step: any) => step.with.name).filter(Boolean)).toEqual([
    "signed-macos-x64",
    "signed-macos-arm64",
    "signed-windows-x64",
  ])
  expect(manual.jobs.release.secrets).toBe("inherit")
  const ci = await Bun.file(
    new URL("../.github/workflows/ci.yml", import.meta.url),
  ).text()
  expect(ci).not.toContain("secrets.")
})

test("an intermediate already included in the PKCS#12 export does not block signing", async () => {
  const signing = await fixture()
  expect(signing.run({ SIGNING_FAILURE: "included-intermediate" }).exitCode).toBe(0)
  expect(await signing.receiptExists()).toBe(true)
  expect(await Bun.file(`${signing.binary}.pkg.notarization.json`).exists()).toBe(true)
})

test("a post-acceptance ticket failure preserves verbose evidence and its original exit status", async () => {
  const signing = await fixture()
  const result = signing.run({ SIGNING_FAILURE: "verification" })
  expect(result.exitCode).toBe(3)
  expect(await signing.receiptExists()).toBe(false)
  const files = await signing.diagnosticFiles()
  expect(files["result.txt"]).toContain("stage=notarization ticket verification")
  expect(files["result.txt"]).toContain("exit_status=3")
  expect(JSON.parse(files["submission.json"]!).status).toBe("Accepted")
  expect(files["notarization-verification.txt"]).toContain("fixture verbose ticket verification")
  expect(files["signed-binary.sha256"]).toContain(
    createHash("sha256").update(await readFile(signing.binary)).digest("hex"),
  )
  expect(files["final-binary.sha256"]).toBe(files["signed-binary.sha256"])
  expect(Object.keys(files).sort()).toEqual([
    "final-binary.sha256", "notarization-system.log", "notarization-verification.txt", "notary-log.json",
    "result.txt", "runner.txt", "signature-verification.txt", "signature.txt",
    "signed-binary.sha256", "submission.json", "final-installer.sha256", "installer-signature.txt",
  ].sort())
  const exported = Object.values(files).join("\n") + result.stdout.toString() + result.stderr.toString()
  for (const secret of ["fixture-p12", "fixture-p8", "fixture-password", "fixture-installer-p12", "fixture-installer-password",
    Buffer.from("fixture-installer-p12").toString("base64"),
    Buffer.from("fixture-p12").toString("base64"), Buffer.from("fixture-p8").toString("base64")])
    expect(exported).not.toContain(secret)
  const calls = await signing.calls()
  const checks = calls.filter((call) => call.includes("--check-notarization"))
  expect(checks).toHaveLength(1)
  expect(checks[0]).toContain("--verbose=4")
  const submit = calls.find((call) => call[0] === "xcrun" && call[2] === "submit")!
  expect(submit).toContain("--wait")
  expect(submit[submit.indexOf("--timeout") + 1]).toBe("30m")
  expect(calls.at(-1)?.slice(0, 2)).toEqual(["security", "delete-keychain"])
})

test("diagnostic collection failures do not turn successful verification into failure", async () => {
  const signing = await fixture()
  const result = signing.run({ SIGNING_FAILURE: "log" })
  expect(result.exitCode).toBe(0)
  expect(await signing.receiptExists()).toBe(true)
  expect((await signing.diagnosticFiles())["result.txt"]).toContain("stage=complete")
})

test("signature failures are distinguished from Apple's acceptance and ticket checks", async () => {
  const signing = await fixture()
  expect(signing.run({ SIGNING_FAILURE: "signature" }).exitCode).toBe(2)
  const files = await signing.diagnosticFiles()
  expect(files["result.txt"]).toContain("stage=signature integrity verification")
  expect(files["submission.json"]).toBeUndefined()
  expect((await signing.calls()).some((call) => call[0] === "xcrun")).toBe(false)
})

for (const action of ["staple", "validate"]) {
  test(`a temporary Apple network failure retries only stapler ${action}`, async () => {
    const signing = await fixture()
    const result = signing.run({ SIGNING_FAILURE: action === "staple" ? "staple-network" : "validation-network" })
    expect(result.exitCode).toBe(0)
    const calls = await signing.calls()
    expect(calls.filter((call) => call[0] === "xcrun" && call[1] === "stapler" && call[2] === action)).toHaveLength(2)
    expect(calls.filter((call) => call[0] === "xcrun" && call[2] === "submit")).toHaveLength(1)
    expect(calls.filter((call) => call[0] === "productsign")).toHaveLength(1)
    expect(calls.filter((call) => call[0] === "sleep").map((call) => call[1])).toEqual(["10"])
    expect(result.stdout.toString()).toContain("The network connection was lost.")
    expect(result.stdout.toString()).toContain(`stapler ${action}: attempt 2/3`)
    const log = (await signing.diagnosticFiles())["installer-stapling.txt"]!
    expect(log).toContain("Code=-1005")
    expect(log).toContain("Stapler succeeded")
    expect(await signing.receiptExists()).toBe(true)
    expect(await Bun.file(`${signing.binary}.pkg.notarization.json`).exists()).toBe(true)
  })
}

test("repeated Apple network failures stop after three attempts and preserve exit 68", async () => {
  const signing = await fixture()
  const result = signing.run({ SIGNING_FAILURE: "validation-network-exhausted" })
  expect(result.exitCode).toBe(68)
  const calls = await signing.calls()
  expect(calls.filter((call) => call[0] === "xcrun" && call[1] === "stapler" && call[2] === "validate")).toHaveLength(3)
  expect(calls.filter((call) => call[0] === "sleep").map((call) => call[1])).toEqual(["10", "20"])
  expect(calls.filter((call) => call[0] === "xcrun" && call[2] === "submit")).toHaveLength(1)
  expect(calls.some((call) => call[0] === "spctl")).toBe(false)
  expect(await signing.receiptExists()).toBe(false)
  expect(await Bun.file(`${signing.binary}.pkg.notarization.json`).exists()).toBe(false)
  const files = await signing.diagnosticFiles()
  expect(files["result.txt"]).toContain("stage=installer ticket validation")
  expect(files["result.txt"]).toContain("exit_status=68")
  expect(files["installer-stapling.txt"]?.match(/Code=-1005/g)).toHaveLength(3)
  expect(calls.at(-1)?.slice(0, 2)).toEqual(["security", "delete-keychain"])
})

test("invalid tickets and TLS trust failures are never retried", async () => {
  for (const failure of ["validation-permanent", "validation-tls"]) {
    const signing = await fixture()
    const result = signing.run({ SIGNING_FAILURE: failure })
    expect(result.exitCode).toBe(68)
    const calls = await signing.calls()
    expect(calls.filter((call) => call[0] === "xcrun" && call[1] === "stapler" && call[2] === "validate")).toHaveLength(1)
    expect(calls.some((call) => call[0] === "sleep" || call[0] === "spctl")).toBe(false)
    expect(await signing.receiptExists()).toBe(false)
    expect(await Bun.file(`${signing.binary}.pkg.notarization.json`).exists()).toBe(false)
  }
})
