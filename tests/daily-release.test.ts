import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

type GitObject = { type: "commit" | "tag" | "tree"; sha: string }
type Release = { draft: boolean; target_commitish: string; name: string; assets?: { name: string }[] }
type FixtureState = {
  ref?: { object: GitObject }
  tagObjects?: Record<string, { object: GitObject }>
  refError?: number
  release?: Release
  uploaded?: string[]
  failUpload?: boolean
  runCreatedAt?: string
  runError?: number
  releaseError?: number
  npmVersion?: string
  npmRequestedVersion?: string
  npmError?: boolean
}

const sourceSha = "258de2c3b9f4e4161e54f5ea14627bc1efa72b2e"
const otherSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const releaseTag = "daily-2026-10-12"
const releaseVersion = "0.0.2839"
const releaseName = `tscircuit standalone ${releaseVersion}`
const archives = [
  "tscircuit-standalone-linux-x64.tar.gz",
  "tscircuit-standalone-linux-arm64.tar.gz",
  "tscircuit-standalone-macos-x64.tar.gz",
  "tscircuit-standalone-macos-arm64.tar.gz",
  "tscircuit-standalone-windows-x64.zip",
]
const binaries = [
  "tsci-linux-x64",
  "tsci-linux-arm64",
  "tsci-darwin-x64",
  "tsci-darwin-arm64",
  "tsci-windows-x64.exe",
]
const assets = [
  ...binaries,
  ...binaries.map((name) => `${name.replace(/\.exe$/, "")}.notices.txt`),
  ...archives,
  "release-manifest.json",
  "tsci-darwin-x64.notarization.json",
  "tsci-darwin-arm64.notarization.json",
]
const workflow = Bun.YAML.parse(
  await Bun.file(
    new URL("../.github/workflows/daily-release.yml", import.meta.url),
  ).text(),
) as {
  jobs: {
    prepare: { steps: { name?: string; run?: string }[] }
  }
}
const publication = Bun.YAML.parse(
  await Bun.file(new URL("../.github/workflows/finalize-release.yml", import.meta.url)).text(),
) as { jobs: { publish: { steps: { name?: string; run?: string }[] } } }
const publishScript = publication.jobs.publish.steps.find(
  (step) => step.name === "Publish the complete daily prerelease",
)?.run
if (!publishScript)
  throw new Error("The daily release publication step is missing")
const verifyScript = publication.jobs.publish.steps.find(
  (step) => step.name === "Verify the release assets and generate checksums",
)?.run
if (!verifyScript)
  throw new Error("The daily release asset verification step is missing")
const prepareScript = workflow.jobs.prepare.steps.find(
  (step) =>
    step.name === "Choose the tscircuit version and skip published dates",
)?.run
if (!prepareScript)
  throw new Error("The daily release preparation step is missing")

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

// Only this fixture CLI can receive the workflow's gh requests. Its REST responses
// reproduce GitHub's missing-reference behavior; it never contacts GitHub.
const ghStub =
  `#!${process.execPath}\n` +
  String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename } from "node:path"
const args = process.argv.slice(2)
const statePath = process.env.GH_FIXTURE_STATE
const state = JSON.parse(readFileSync(statePath, "utf8"))
appendFileSync(process.env.GH_FIXTURE_CALLS, JSON.stringify(args) + "\n")
const save = () => writeFileSync(statePath, JSON.stringify(state))
const fail = (message) => { process.stderr.write(message + "\n"); process.exit(1) }
const apiError = (status) => fail("gh: fixture API error (HTTP " + status + ")")
const flag = (name) => args[args.indexOf(name) + 1]
const output = (value) => {
  const queryIndex = args.indexOf("--jq")
  if (queryIndex === -1) return process.stdout.write(JSON.stringify(value) + "\n")
  const filtered = Bun.spawnSync(["/usr/bin/jq", "-r", args[queryIndex + 1]], {
    stdin: Buffer.from(JSON.stringify(value)),
  })
  process.stdout.write(filtered.stdout)
  process.stderr.write(filtered.stderr)
  process.exit(filtered.exitCode)
}
if (args[0] === "api") {
  const endpoint = args[1]
  // GitHub returns 422 for an unknown commit name, whereas exact git refs use 404.
  if (endpoint.includes("/commits/")) apiError(422)
  if (endpoint.includes("/actions/runs/")) {
    if (state.runError) apiError(state.runError)
    output({ created_at: state.runCreatedAt ?? "2026-10-12T10:35:23Z" })
  } else if (endpoint.includes("/git/ref/tags/")) {
    if (state.refError) apiError(state.refError)
    if (!state.ref) apiError(404)
    output(state.ref)
  } else if (endpoint.includes("/git/tags/")) {
    const tag = state.tagObjects?.[endpoint.split("/git/tags/")[1]]
    if (!tag) apiError(404)
    output(tag)
  } else if (endpoint.includes("/releases/tags/")) {
    if (state.releaseError) apiError(state.releaseError)
    if (!state.release) apiError(404)
    output(state.release)
  } else fail("Unexpected API endpoint: " + endpoint)
} else if (args[0] === "release" && args[1] === "create") {
  if (state.release) fail("A release already exists")
  if (!args.includes("--draft") || !args.includes("--prerelease")) fail("Expected a draft prerelease")
  state.release = { draft: true, target_commitish: flag("--target"), name: flag("--title") }
  save()
} else if (args[0] === "release" && args[1] === "upload") {
  if (!state.release?.draft) fail("Uploads must target a private draft")
  const files = args.slice(3).filter((arg) => !arg.startsWith("--"))
  if (files.some((path) => !existsSync(path))) fail("An upload file is missing")
  state.uploaded = files.map((path) => basename(path)).sort()
  if (state.failUpload) {
    state.failUpload = false
    state.uploaded = state.uploaded.slice(0, 2)
    save()
    fail("Fixture upload failed")
  }
  save()
} else if (args[0] === "release" && args[1] === "edit") {
  if (!state.release?.draft) fail("Only the draft may be published")
  if (!args.includes("--draft=false") || !args.includes("--prerelease") || !args.includes("--latest=false"))
    fail("Expected prerelease publication without changing latest")
  state.release.draft = false
  save()
} else fail("Unexpected gh command: " + JSON.stringify(args))
`

const curlStub =
  `#!${process.execPath}\n` +
  String.raw`
import { appendFileSync, readFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(process.env.CURL_FIXTURE_CALLS, JSON.stringify(args) + "\n")
const state = JSON.parse(readFileSync(process.env.GH_FIXTURE_STATE, "utf8"))
if (args.at(-1) !== "https://registry.npmjs.org/tscircuit/" + (state.npmRequestedVersion ?? "latest")) {
  process.stderr.write("Unexpected fixture curl URL\n")
  process.exit(1)
}
if (state.npmError) {
  process.stderr.write("curl: fixture registry error\n")
  process.exit(22)
}
process.stdout.write(JSON.stringify({ version: state.npmVersion ?? "0.0.2839" }) + "\n")
`

const fixture = async (initialState: FixtureState = {}) => {
  const root = await mkdtemp(join(tmpdir(), "standalone-daily-release-"))
  directories.push(root)
  const bin = join(root, "bin")
  await mkdir(bin)
  await writeFile(join(bin, "gh"), ghStub)
  await chmod(join(bin, "gh"), 0o755)
  await writeFile(join(bin, "curl"), curlStub)
  await chmod(join(bin, "curl"), 0o755)
  // Reruns must use the original GitHub run date, regardless of the runner clock.
  await writeFile(join(bin, "date"), "#!/bin/sh\nprintf '2099-01-01\\n'\n")
  await chmod(join(bin, "date"), 0o755)
  if (process.platform === "darwin") {
    await writeFile(
      join(bin, "sha256sum"),
      '#!/bin/sh\nexec /usr/bin/shasum -a 256 "$@"\n',
    )
    await chmod(join(bin, "sha256sum"), 0o755)
  }
  const statePath = join(root, "state.json")
  const callsPath = join(root, "calls.jsonl")
  const curlCallsPath = join(root, "curl-calls.jsonl")
  const outputPath = join(root, "github-output.txt")
  await writeFile(statePath, JSON.stringify(initialState))
  await writeFile(callsPath, "")
  await writeFile(curlCallsPath, "")
  await writeFile(outputPath, "")
  for (const name of assets)
    await writeFile(join(root, name), `Fixture ${name}\n`)
  for (const arch of ["x64", "arm64"]) {
    const binary = `tsci-darwin-${arch}`
    const content = await readFile(join(root, binary))
    await writeFile(join(root, `${binary}.notarization.json`), JSON.stringify({
      id: `accepted-${arch}`,
      status: "Accepted",
      teamId: "WUQ9WUY75Z",
      sha256: createHash("sha256").update(content).digest("hex"),
    }))
    const stage = join(root, `macos-${arch}`)
    await mkdir(stage)
    await writeFile(join(stage, "tsci"), content)
    const packed = Bun.spawnSync(["tar", "-czf", join(root, `tscircuit-standalone-macos-${arch}.tar.gz`), "-C", stage, "tsci"])
    if (packed.exitCode !== 0) throw new Error(packed.stderr.toString())
  }
  const runScript = (script: string, env: Record<string, string> = {}) =>
    Bun.spawnSync(["/bin/bash", "-eo", "pipefail", "-c", script], {
      cwd: root,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        GH_TOKEN: "fixture-token-with-no-access",
        GH_REPO: "fixture/standalone",
        GH_FIXTURE_STATE: statePath,
        GH_FIXTURE_CALLS: callsPath,
        CURL_FIXTURE_CALLS: curlCallsPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_SHA: sourceSha,
        GITHUB_RUN_ID: "123",
        RELEASE_TAG: releaseTag,
        RELEASE_VERSION: releaseVersion,
        SOURCE_SHA: sourceSha,
        RUN_URL: "https://example.invalid/actions/runs/1",
        ...env,
      },
    })
  const verify = () => runScript(verifyScript)
  const run = (env: Record<string, string> = {}) =>
    runScript(`${verifyScript}\n${publishScript}`, env)
  const prepare = (env: Record<string, string> = {}) => runScript(prepareScript, env)
  const state = async () =>
    JSON.parse(await readFile(statePath, "utf8")) as FixtureState
  const calls = async () =>
    (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
  const mutations = async () =>
    (await calls()).filter((args) => args[0] === "release")
  const curlCalls = async () =>
    (await readFile(curlCallsPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
  const outputs = async () =>
    Object.fromEntries(
      (await readFile(outputPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("=")),
    )
  return { root, run, verify, prepare, state, calls, mutations, curlCalls, outputs }
}

test("checksums cover every direct binary, notices file and optional archive", async () => {
  const release = await fixture()
  const result = release.verify()
  expect(result.exitCode).toBe(0)
  const sums = await readFile(join(release.root, "SHA256SUMS"), "utf8")
  const expected = await Promise.all(
    assets.map(async (name) => {
      const bytes = await readFile(join(release.root, name))
      return `${createHash("sha256").update(bytes).digest("hex")}  ${name}`
    }),
  )
  expect(sums.trim().split("\n").sort()).toEqual(expected.sort())
})

test("missing or empty release assets prevent publication", async () => {
  for (const asset of assets) {
    for (const missing of [true, false]) {
      const release = await fixture()
      if (missing) await rm(join(release.root, asset))
      else await writeFile(join(release.root, asset), "")
      expect(release.run().exitCode).not.toBe(0)
      expect(await release.mutations()).toEqual([])
    }
  }
})

test("unaccepted receipts, wrong teams and changed macOS binaries cannot publish", async () => {
  for (const arch of ["x64", "arm64"]) {
    for (const change of [
      { status: "Invalid" },
      { status: "In Progress" },
      { teamId: "WRONGTEAM1" },
      { sha256: "0".repeat(64) },
      { id: "" },
    ]) {
      const release = await fixture()
      const receiptPath = join(release.root, `tsci-darwin-${arch}.notarization.json`)
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"))
      await writeFile(receiptPath, JSON.stringify({ ...receipt, ...change }))
      expect(release.run().exitCode).not.toBe(0)
      expect(await release.mutations()).toEqual([])
    }
    const release = await fixture()
    await writeFile(join(release.root, `tsci-darwin-${arch}`), "Changed binary")
    expect(release.run().exitCode).not.toBe(0)
    expect(await release.mutations()).toEqual([])
  }
})

test("an archive containing a different executable cannot publish", async () => {
  const release = await fixture()
  await writeFile(join(release.root, "macos-arm64/tsci"), "Old unsigned binary")
  const packed = Bun.spawnSync(["tar", "-czf", join(release.root, "tscircuit-standalone-macos-arm64.tar.gz"), "-C", join(release.root, "macos-arm64"), "tsci"])
  expect(packed.exitCode).toBe(0)
  expect(release.run().exitCode).not.toBe(0)
  expect(await release.mutations()).toEqual([])
})

test("a missing git ref publishes the first release despite unknown commits returning 422", async () => {
  const release = await fixture()
  const result = release.run()
  expect(result.exitCode).toBe(0)
  expect(await release.state()).toMatchObject({
    release: { draft: false, target_commitish: sourceSha, name: releaseName },
    uploaded: [...assets, "SHA256SUMS"].sort(),
  })
  const requests = await release.calls()
  expect(requests[0]?.[1]).toBe(
    `repos/fixture/standalone/git/ref/tags/${releaseTag}`,
  )
  expect(requests.some((args) => args[1]?.includes("/commits/"))).toBe(false)
  expect((await release.mutations()).map((args) => args[1])).toEqual([
    "create",
    "upload",
    "edit",
  ])
  expect(
    await readFile(join(release.root, "release-notes.md"), "utf8"),
  ).toContain(`Version: ${releaseVersion}`)
  const notes = await readFile(join(release.root, "release-notes.md"), "utf8")
  expect(notes.indexOf("## Download a binary")).toBeLessThan(
    notes.indexOf(`Version: ${releaseVersion}`),
  )
  for (const binary of binaries) {
    expect(notes).toContain(
      `https://github.com/fixture/standalone/releases/download/${releaseTag}/${binary})`,
    )
    expect(notes).toContain(
      `https://github.com/fixture/standalone/releases/download/${releaseTag}/${binary.replace(/\.exe$/, "")}.notices.txt)`,
    )
  }
})

test("direct and nested annotated tags may publish only when they resolve to the source commit", async () => {
  for (const initialState of [
    { ref: { object: { type: "commit", sha: sourceSha } } },
    {
      ref: { object: { type: "tag", sha: "outer-tag" } },
      tagObjects: {
        "outer-tag": { object: { type: "tag", sha: "inner-tag" } },
        "inner-tag": { object: { type: "commit", sha: sourceSha } },
      },
    },
  ] satisfies FixtureState[]) {
    const release = await fixture(initialState)
    expect(release.run().exitCode).toBe(0)
    expect((await release.state()).release?.draft).toBe(false)
    if (initialState.tagObjects)
      expect(
        (await release.calls()).filter((args) =>
          args[1]?.includes("/git/tags/"),
        ).length,
      ).toBe(2)
  }
})

test("direct and annotated tags pointing at another commit cannot publish", async () => {
  for (const initialState of [
    { ref: { object: { type: "commit", sha: otherSha } } },
    {
      ref: { object: { type: "tag", sha: "wrong-tag" } },
      tagObjects: {
        "wrong-tag": { object: { type: "commit", sha: otherSha } },
      },
    },
  ] satisfies FixtureState[]) {
    const release = await fixture(initialState)
    expect(release.run().exitCode).not.toBe(0)
    expect(await release.mutations()).toEqual([])
  }
})

test("authentication and validation errors are not mistaken for absent refs", async () => {
  for (const refError of [403, 422]) {
    const release = await fixture({ refError })
    const result = release.run()
    expect(result.exitCode).not.toBe(0)
    expect(Buffer.concat([result.stdout, result.stderr]).toString()).toContain(
      `HTTP ${refError}`,
    )
    expect(await release.mutations()).toEqual([])
  }
})

test("an already published date remains unchanged", async () => {
  const initialState: FixtureState = {
    ref: { object: { type: "commit", sha: sourceSha } },
    release: { draft: false, target_commitish: sourceSha, name: releaseName },
    uploaded: ["existing-asset"],
  }
  const release = await fixture(initialState)
  expect(release.run().exitCode).toBe(0)
  expect(await release.state()).toEqual(initialState)
  expect(await release.mutations()).toEqual([])
})

test("an interrupted upload leaves a draft and a retry publishes every asset", async () => {
  const release = await fixture({ failUpload: true })
  expect(release.run().exitCode).not.toBe(0)
  expect((await release.state()).release).toEqual({
    draft: true,
    target_commitish: sourceSha,
    name: releaseName,
  })
  expect((await release.mutations()).map((args) => args[1])).toEqual([
    "create",
    "upload",
  ])
  expect(release.run().exitCode).toBe(0)
  expect((await release.state()).uploaded).toEqual(
    [...assets, "SHA256SUMS"].sort(),
  )
  expect((await release.state()).release?.draft).toBe(false)
  expect((await release.mutations()).map((args) => args[1])).toEqual([
    "create",
    "upload",
    "upload",
    "edit",
  ])
})

test("a draft built for a different tscircuit version cannot receive new assets", async () => {
  const release = await fixture({
    release: {
      draft: true,
      target_commitish: sourceSha,
      name: "tscircuit standalone 0.0.2838",
    },
  })
  expect(release.run().exitCode).not.toBe(0)
  expect(await release.mutations()).toEqual([])
})

test("a draft from a different standalone source commit cannot receive new assets", async () => {
  const release = await fixture({
    release: { draft: true, target_commitish: otherSha, name: releaseName },
  })
  expect(release.run().exitCode).not.toBe(0)
  expect(await release.mutations()).toEqual([])
})

test("preparation selects the exact latest npm version for a fresh daily release", async () => {
  const release = await fixture({ npmVersion: "0.0.3000" })
  expect(release.prepare().exitCode).toBe(0)
  expect(await release.outputs()).toEqual({
    tag: releaseTag,
    version: "0.0.3000",
    publish: "true",
  })
  const registryRequests = await release.curlCalls()
  expect(registryRequests.length).toBe(1)
  expect(registryRequests[0]?.at(-1)).toBe(
    "https://registry.npmjs.org/tscircuit/latest",
  )
  expect(await release.mutations()).toEqual([])
})

test("preparation preserves a same-source draft version after npm latest changes", async () => {
  const release = await fixture({
    release: { draft: true, target_commitish: sourceSha, name: releaseName },
    npmVersion: "0.0.3000",
  })
  expect(release.prepare().exitCode).toBe(0)
  expect(await release.outputs()).toEqual({
    tag: releaseTag,
    version: releaseVersion,
    publish: "true",
  })
  expect(await release.curlCalls()).toEqual([])
  expect(await release.mutations()).toEqual([])
})

test("preparation skips a published date without querying the npm registry", async () => {
  const release = await fixture({
    release: { draft: false, target_commitish: sourceSha, name: releaseName },
    npmError: true,
  })
  expect(release.prepare().exitCode).toBe(0)
  expect(await release.outputs()).toEqual({ tag: releaseTag, publish: "false" })
  expect(await release.curlCalls()).toEqual([])
  expect(await release.mutations()).toEqual([])
})

test("a complete pending draft is left for the checker without rebuilding or resubmitting", async () => {
  const release = await fixture({
    release: { draft: true, target_commitish: sourceSha, name: releaseName,
      assets: [{ name: "release-manifest.json" }] },
    npmError: true,
  })
  expect(release.prepare().exitCode).toBe(0)
  expect(await release.outputs()).toEqual({ tag: releaseTag, publish: "false" })
  expect(await release.curlCalls()).toEqual([])
  expect(await release.mutations()).toEqual([])
})

test("preparation rejects drafts from another source and non-absence GitHub API errors", async () => {
  for (const initialState of [
    { release: { draft: true, target_commitish: otherSha, name: releaseName } },
    { releaseError: 403 },
    { runError: 403 },
  ] satisfies FixtureState[]) {
    const release = await fixture(initialState)
    expect(release.prepare().exitCode).not.toBe(0)
    expect((await release.outputs()).publish).toBeUndefined()
    expect(await release.curlCalls()).toEqual([])
    expect(await release.mutations()).toEqual([])
  }
})

test("preparation uses the original run creation date instead of the runner date", async () => {
  const release = await fixture({ runCreatedAt: "2025-01-02T23:59:00Z" })
  expect(release.prepare().exitCode).toBe(0)
  expect((await release.outputs()).tag).toBe("daily-2025-01-02")
  expect((await release.calls())[0]?.[1]).toBe(
    "repos/fixture/standalone/actions/runs/123",
  )
  expect(await release.mutations()).toEqual([])
})

test("preparation cannot release with invalid versions or failed registry requests", async () => {
  for (const initialState of [
    { npmVersion: "invalid" },
    { npmError: true },
    {
      release: {
        draft: true,
        target_commitish: sourceSha,
        name: "daily build",
      },
    },
  ] satisfies FixtureState[]) {
    const release = await fixture(initialState)
    expect(release.prepare().exitCode).not.toBe(0)
    expect((await release.outputs()).publish).toBeUndefined()
    expect(await release.mutations()).toEqual([])
  }
})


test("manual preparation uses a run-specific tag and can select an exact upstream version", async () => {
  const release = await fixture({ npmRequestedVersion: "0.0.2857", npmVersion: "0.0.2857" })
  expect(release.prepare({ MANUAL_RELEASE: "true", REQUESTED_VERSION: "0.0.2857" }).exitCode).toBe(0)
  expect(await release.outputs()).toEqual({
    tag: "manual-2026-10-12-123", version: "0.0.2857", publish: "true",
  })
  expect((await release.curlCalls())[0]?.at(-1)).toBe("https://registry.npmjs.org/tscircuit/0.0.2857")
})

test("manual retries preserve the run tag and draft version after npm latest changes", async () => {
  const release = await fixture({
    release: { draft: true, target_commitish: sourceSha, name: releaseName },
    npmVersion: "0.0.3000",
  })
  expect(release.prepare({ MANUAL_RELEASE: "true" }).exitCode).toBe(0)
  expect(await release.outputs()).toEqual({
    tag: "manual-2026-10-12-123", version: releaseVersion, publish: "true",
  })
  expect(await release.curlCalls()).toEqual([])
})

test("manual preparation rejects unsafe input and mismatched registry or draft versions", async () => {
  const invalid = await fixture()
  expect(invalid.prepare({ MANUAL_RELEASE: "true", REQUESTED_VERSION: "latest/../../other" }).exitCode).not.toBe(0)
  expect(await invalid.curlCalls()).toEqual([])
  expect((await invalid.outputs()).publish).toBeUndefined()
  for (const initialState of [
    { npmRequestedVersion: "0.0.2857", npmVersion: releaseVersion },
    { release: { draft: true, target_commitish: sourceSha, name: releaseName } },
  ] satisfies FixtureState[]) {
    const release = await fixture(initialState)
    expect(release.prepare({ MANUAL_RELEASE: "true", REQUESTED_VERSION: "0.0.2857" }).exitCode).not.toBe(0)
    expect((await release.outputs()).publish).toBeUndefined()
    expect(await release.mutations()).toEqual([])
  }
})

test("manual retries leave a published run unchanged without a registry request", async () => {
  const release = await fixture({
    release: { draft: false, target_commitish: sourceSha, name: releaseName }, npmError: true,
  })
  expect(release.prepare({ MANUAL_RELEASE: "true" }).exitCode).toBe(0)
  expect(await release.outputs()).toEqual({ tag: "manual-2026-10-12-123", publish: "false" })
  expect(await release.curlCalls()).toEqual([])
  expect(await release.mutations()).toEqual([])
})


test("a manual latest release publishes all assets under its unique tag with manual notes", async () => {
  const release = await fixture()
  expect(release.prepare({ MANUAL_RELEASE: "true" }).exitCode).toBe(0)
  const outputs = await release.outputs()
  expect(outputs.tag).toBe("manual-2026-10-12-123")
  expect(release.run({ RELEASE_TAG: outputs.tag!, RELEASE_VERSION: outputs.version!, BUILD_KIND: "Manual" }).exitCode).toBe(0)
  expect((await release.state()).release?.draft).toBe(false)
  expect((await release.state()).uploaded).toEqual([...assets, "SHA256SUMS"].sort())
  expect((await release.mutations()).every((args) => args[2] === outputs.tag)).toBe(true)
  expect(await readFile(join(release.root, "release-notes.md"), "utf8")).toContain("Manual development build")
  for (const binary of binaries) {
    expect(await readFile(join(release.root, "release-notes.md"), "utf8")).toContain(
      `https://github.com/fixture/standalone/releases/download/${outputs.tag}/${binary})`,
    )
  }
})
