import { createHash, createPrivateKey, sign } from "node:crypto"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const teamId = "WUQ9WUY75Z"
export const manifestName = "release-manifest.json"
export const arches = ["x64", "arm64"] as const
export const releaseFiles = [
  "tsci-linux-x64", "tsci-linux-arm64", "tsci-darwin-x64",
  "tsci-darwin-arm64", "tsci-windows-x64.exe",
  ...["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"]
    .map((target) => "tsci-" + target + ".notices.txt"),
  ...["linux-x64", "linux-arm64", "macos-x64", "macos-arm64"]
    .map((target) => "tscircuit-standalone-" + target + ".tar.gz"),
  "tscircuit-standalone-windows-x64.zip",
]
type Arch = typeof arches[number]
type Receipt = { id: string; status: string; teamId: string; sha256: string }
type Asset = { id: number; name: string }
type Release = {
  id: number; draft: boolean; tag_name: string; target_commitish: string
  name: string; body: string; assets: Asset[]
}
export type Manifest = {
  schema: 1; tag: string; version: string; sourceSha: string
  kind: "Manual" | "Daily"; runUrl: string
  files: Record<string, string>; macos: Record<Arch, Receipt>
}
export type Plan = { manifest: Manifest; macos: Record<Arch, Receipt> }
type Request = (url: string, init?: RequestInit) => Promise<Response>

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const tagPattern = /^(daily-\d{4}-\d{2}-\d{2}|manual-\d{4}-\d{2}-\d{2}-\d+)$/
const versionPattern = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hashPattern = /^[0-9a-f]{64}$/
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
function checkTag(tag: string) {
  assert(tagPattern.test(tag), "Invalid standalone release tag")
}
function receiptName(arch: Arch) { return "tsci-darwin-" + arch + ".notarization.json" }
function macFiles(arch: Arch) {
  return ["tsci-darwin-" + arch, "tsci-darwin-" + arch + ".notices.txt",
    "tscircuit-standalone-macos-" + arch + ".tar.gz"]
}
function validateReceipt(value: Receipt, hash: string) {
  assert(value && uuidPattern.test(value.id) && value.teamId === teamId &&
    hashPattern.test(value.sha256) && value.sha256 === hash,
  "Invalid submission ID, signing team or signed binary checksum")
}
export function validateManifest(value: Manifest, release: Release, repo: string) {
  assert(value?.schema === 1, "Unsupported release manifest")
  checkTag(value.tag)
  assert(versionPattern.test(value.version) && /^[0-9a-f]{40}$/.test(value.sourceSha),
    "Invalid release version or source commit")
  assert(value.tag === release.tag_name && value.sourceSha === release.target_commitish &&
    release.name === "tscircuit standalone " + value.version, "Draft identity changed")
  assert(value.kind === "Manual" || value.kind === "Daily", "Invalid release kind")
  assert(new RegExp("^https://github.com/" + repo + "/actions/runs/[0-9]+$").test(value.runUrl),
    "Invalid originating workflow URL")
  assert(value.files && Object.keys(value.files).length === releaseFiles.length &&
    releaseFiles.every((name) => hashPattern.test(value.files[name] ?? "")),
    "Manifest must cover every binary, notice and archive")
  for (const arch of arches) {
    validateReceipt(value.macos?.[arch], value.files["tsci-darwin-" + arch]!)
  }
}

export class GitHub {
  constructor(readonly repo: string, readonly token: string, readonly request: Request = fetch) {
    assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo), "Invalid repository")
  }
  async api(path: string, method = "GET", body?: unknown): Promise<any> {
    const response = await this.request("https://api.github.com/repos/" + this.repo + path, {
      method, headers: { Authorization: "Bearer " + this.token,
        Accept: "application/vnd.github+json", "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    if (response.status === 404 && method === "GET") return undefined
    assert(response.ok, "GitHub " + method + " " + path + ": HTTP " + response.status)
    return response.status === 204 ? undefined : response.json()
  }
  async release(tag: string): Promise<Release> {
    checkTag(tag)
    const release = await this.api("/releases/tags/" + tag)
    assert(release, "Release draft not found")
    return release
  }
  async drafts() {
    const drafts: Release[] = []
    for (let page = 1; ; page++) {
      const batch: Release[] = await this.api("/releases?per_page=100&page=" + page)
      drafts.push(...batch.filter((r) => r.draft && tagPattern.test(r.tag_name) &&
        r.assets.some((a) => a.name === manifestName)))
      if (batch.length < 100) return drafts
    }
  }
  async bytes(release: Release, name: string) {
    const asset = release.assets.find((a) => a.name === name)
    assert(asset && Number.isSafeInteger(asset.id), "Missing draft asset: " + name)
    let response = await this.request("https://api.github.com/repos/" + this.repo +
      "/releases/assets/" + asset.id, {
      headers: { Authorization: "Bearer " + this.token, Accept: "application/octet-stream" },
      redirect: "manual", signal: AbortSignal.timeout(120_000),
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location")
      assert(typeof location === "string" && location.startsWith("https://"), "Invalid asset redirect")
      // The signed download URL does not receive the repository credential.
      response = await this.request(location, { signal: AbortSignal.timeout(120_000) })
    }
    assert(response.ok, "Asset download failed: " + name + " HTTP " + response.status)
    return new Uint8Array(await response.arrayBuffer())
  }
  async upload(release: Release, name: string, bytes: Uint8Array) {
    const existing = release.assets.find((a) => a.name === name)
    if (existing) {
      assert(sha256(await this.bytes(release, name)) === sha256(bytes),
        "Refusing to replace saved release bytes: " + name)
      return
    }
    const response = await this.request("https://uploads.github.com/repos/" + this.repo +
      "/releases/" + release.id + "/assets?name=" + encodeURIComponent(name), {
      method: "POST", headers: { Authorization: "Bearer " + this.token,
        "Content-Type": "application/octet-stream" }, body: bytes as BodyInit,
      signal: AbortSignal.timeout(120_000),
    })
    assert(response.ok, "Asset upload failed: " + name + " HTTP " + response.status)
    release.assets.push(await response.json() as Asset)
  }
}

export function appleToken(key: string, keyId: string, issuer: string, now = Date.now()) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const header = encode({ alg: "ES256", kid: keyId, typ: "JWT" })
  const iat = Math.floor(now / 1000)
  const payload = encode({ iss: issuer, iat, exp: iat + 600, aud: "appstoreconnect-v1" })
  const data = header + "." + payload
  const signature = sign("sha256", Buffer.from(data), {
    key: createPrivateKey(Buffer.from(key, "base64")), dsaEncoding: "ieee-p1363",
  })
  return data + "." + signature.toString("base64url")
}
export class Apple {
  constructor(readonly token: string, readonly request: Request = fetch) {}
  async status(id: string): Promise<string> {
    assert(uuidPattern.test(id), "Invalid Apple submission ID")
    const response = await this.request("https://appstoreconnect.apple.com/notary/v2/submissions/" + id, {
      headers: { Authorization: "Bearer " + this.token }, signal: AbortSignal.timeout(30_000),
    })
    assert(response.ok, "Apple status query failed: HTTP " + response.status)
    const result = await response.json() as any
    assert(result.data?.id === id, "Apple returned a different submission")
    const status = result.data.attributes?.status
    assert(["Accepted", "In Progress", "Invalid", "Rejected"].includes(status), "Unknown Apple status")
    return status
  }
  async log(id: string) {
    const response = await this.request("https://appstoreconnect.apple.com/notary/v2/submissions/" + id + "/logs", {
      headers: { Authorization: "Bearer " + this.token }, signal: AbortSignal.timeout(30_000),
    })
    assert(response.ok, "Apple log query failed: HTTP " + response.status)
    const result = await response.json() as any
    const url = result.data?.attributes?.developerLogUrl
    assert(typeof url === "string" && url.startsWith("https://"), "Invalid Apple log URL")
    const log = await this.request(url, { signal: AbortSignal.timeout(30_000) })
    assert(log.ok, "Apple log download failed")
    return log.json()
  }
}

export async function readManifest(gh: GitHub, release: Release): Promise<Manifest> {
  const manifest = JSON.parse(new TextDecoder().decode(await gh.bytes(release, manifestName)))
  validateManifest(manifest, release, gh.repo)
  // Only source commits already on main may supply code to privileged finalizers.
  const comparison = await gh.api("/compare/" + manifest.sourceSha + "...main")
  assert(comparison && ["ahead", "identical"].includes(comparison.status),
    "Release source is not an ancestor of main")
  return manifest
}
export async function inspect(gh: GitHub, apple: Apple, release: Release) {
  const manifest = await readManifest(gh, release)
  const macos = {} as Record<Arch, Receipt>
  for (const arch of arches) {
    macos[arch] = { ...manifest.macos[arch], status: await apple.status(manifest.macos[arch].id) }
  }
  const rejected = arches.some((arch) => ["Invalid", "Rejected"].includes(macos[arch].status))
  const ready = arches.every((arch) => macos[arch].status === "Accepted")
  return { manifest, macos, ready, rejected }
}
async function writeOutput(name: string, value: string, env: NodeJS.ProcessEnv) {
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, name + "=" + value + "\n")
}
async function writeSummary(text: string, env: NodeJS.ProcessEnv) {
  console.log(text)
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text + "\n")
}
async function downloadFiles(gh: GitHub, release: Release, manifest: Manifest, names: string[], dir: string) {
  await mkdir(dir, { recursive: true })
  for (const name of names) {
    const bytes = await gh.bytes(release, name)
    assert(bytes.length && sha256(bytes) === manifest.files[name], "Saved asset changed: " + name)
    await writeFile(join(dir, name), bytes)
  }
}

export async function run(command: string, env: NodeJS.ProcessEnv = process.env, request: Request = fetch) {
  const output = (name: string, value: string) => writeOutput(name, value, env)
  const summary = (text: string) => writeSummary(text, env)
  const required = (name: string) => { assert(env[name], "Missing " + name); return env[name]! }
  const gh = new GitHub(required("GH_REPO"), required("GH_TOKEN"), request)
  const tag = env.RELEASE_TAG ?? ""
  if (tag) checkTag(tag)
  if (!["scan", "download"].includes(command)) assert(tag, "Missing RELEASE_TAG")
  const dir = env.RELEASE_DIR ?? "dist/release"
  if (command === "init") {
    const version = required("RELEASE_VERSION"), sourceSha = required("SOURCE_SHA")
    assert(versionPattern.test(version) && /^[0-9a-f]{40}$/.test(sourceSha), "Invalid draft identity")
    let release: Release | undefined = await gh.api("/releases/tags/" + tag)
    if (!release) release = await gh.api("/releases", "POST", {
      tag_name: tag, target_commitish: sourceSha, name: "tscircuit standalone " + version,
      draft: true, prerelease: true, body: "Preparing signed binaries for Apple notarization.",
    })
    assert(release?.draft && release.target_commitish === sourceSha &&
      release.name === "tscircuit standalone " + version, "Draft identity changed")
    // Preserve earlier successful uploads when retrying an incomplete submission run.
    for (const name of releaseFiles.filter((n) => !n.includes("darwin") && !n.includes("macos"))) {
      if (!release.assets.some((a) => a.name === name))
        await gh.upload(release, name, await readFile(join(dir, name)))
    }
    return
  }
  if (command === "restore-macos" || command === "save-macos") {
    const arch = required("ARCH") as Arch
    assert(arches.includes(arch), "Invalid architecture")
    const release = await gh.release(tag)
    assert(release.draft && release.target_commitish === required("SOURCE_SHA") &&
      release.name === "tscircuit standalone " + required("RELEASE_VERSION"), "Draft identity changed")
    const saved = release.assets.some((a) => a.name === receiptName(arch))
    const recovered = !saved && await Bun.file(join(dir, receiptName(arch))).exists()
    if (command === "restore-macos") {
      if (saved) {
        const bytes = await gh.bytes(release, receiptName(arch))
        const receipt: Receipt = JSON.parse(new TextDecoder().decode(bytes))
        validateReceipt(receipt, receipt.sha256)
        await mkdir(dir, { recursive: true })
        for (const name of macFiles(arch)) {
          const data = await gh.bytes(release, name)
          if (name === macFiles(arch)[0]) assert(sha256(data) === receipt.sha256, "Saved binary changed")
          await writeFile(join(dir, name), data)
        }
        await writeFile(join(dir, receiptName(arch)), bytes)
      } else if (recovered) {
        // A prior attempt may have saved an Actions artifact before a draft upload failed.
        const receipt: Receipt = JSON.parse(await readFile(join(dir, receiptName(arch)), "utf8"))
        validateReceipt(receipt, sha256(await readFile(join(dir, macFiles(arch)[0]!))))
        for (const name of macFiles(arch))
          assert((await readFile(join(dir, name))).length, "Incomplete recovered submission")
      }
      await output("reused", String(saved || recovered))
    } else {
      const receipt: Receipt = JSON.parse(await readFile(join(dir, receiptName(arch)), "utf8"))
      validateReceipt(receipt, sha256(await readFile(join(dir, macFiles(arch)[0]!))))
      for (const name of [...macFiles(arch), receiptName(arch)]) {
        await gh.upload(release, name, await readFile(join(dir, name)))
      }
      await summary(tag + " " + arch + ": submitted to Apple as " + receipt.id)
    }
    return
  }
  if (command === "seal") {
    const release = await gh.release(tag)
    assert(release.draft, "Release is already published")
    const files: Record<string, string> = {}
    for (const name of releaseFiles) {
      const bytes = await gh.bytes(release, name)
      assert(bytes.length, "Empty release asset: " + name)
      files[name] = sha256(bytes)
    }
    const macos = {} as Record<Arch, Receipt>
    for (const arch of arches)
      macos[arch] = JSON.parse(new TextDecoder().decode(await gh.bytes(release, receiptName(arch))))
    const manifest: Manifest = { schema: 1, tag, version: required("RELEASE_VERSION"),
      sourceSha: required("SOURCE_SHA"), kind: env.BUILD_KIND === "Manual" ? "Manual" : "Daily",
      runUrl: required("RUN_URL"), files, macos }
    validateManifest(manifest, release, gh.repo)
    await gh.api("/releases/" + release.id, "PATCH", {
      body: "Awaiting Apple notarization. Signed binaries are saved; no runner is waiting.\n\n" +
        "Submission run: " + manifest.runUrl,
    })
    // Upload last: this immutable marker makes a complete draft discoverable to the checker.
    await gh.upload(release, manifestName, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"))
    await summary(tag + ": awaiting Apple notarization; the scheduled checker will continue this release.")
    return
  }
  if (command === "download") {
    const plan: Plan = JSON.parse(await readFile(required("PLAN_FILE"), "utf8"))
    const release = await gh.release(plan.manifest.tag)
    assert(release.draft, "Release is already published")
    validateManifest(plan.manifest, release, gh.repo)
    for (const arch of arches) {
      validateReceipt(plan.macos[arch], plan.manifest.files["tsci-darwin-" + arch]!)
      assert(plan.macos[arch].status === "Accepted" &&
        plan.macos[arch].id === plan.manifest.macos[arch].id, "Submission is not accepted")
    }
    const arch = env.ARCH as Arch | undefined
    assert(!arch || arches.includes(arch), "Invalid architecture")
    await downloadFiles(gh, release, plan.manifest, arch ? macFiles(arch) : releaseFiles, dir)
    for (const a of arch ? [arch] : arches)
      await writeFile(join(dir, receiptName(a)), JSON.stringify(plan.macos[a]) + "\n")
    if (!arch) await writeFile(join(dir, manifestName), JSON.stringify(plan.manifest, null, 2) + "\n")
    return
  }
  assert(command === "scan" || command === "plan", "Unknown release queue command")
  const apple = new Apple(appleToken(required("APPLE_NOTARY_KEY_P8_BASE64"),
    required("APPLE_NOTARY_KEY_ID"), required("APPLE_NOTARY_ISSUER_ID")), request)
  const releases = tag ? [await gh.release(tag)] : await gh.drafts()
  const ready: string[] = [], errors: string[] = []
  for (const release of releases) {
    if (!release.draft) continue
    if (!tag && release.body?.includes("<!-- notarization-blocked -->")) continue
    try {
      const result = await inspect(gh, apple, release)
      await summary(release.tag_name + ": " + arches.map((a) => a + " " + result.macos[a].status).join(", "))
      if (result.rejected) {
        for (const arch of arches) {
          if (["Invalid", "Rejected"].includes(result.macos[arch].status))
            await gh.upload(release, "notarization-" + arch + ".log.json",
              Buffer.from(JSON.stringify(await apple.log(result.macos[arch].id), null, 2)))
        }
        await gh.api("/releases/" + release.id, "PATCH", {
          body: "<!-- notarization-blocked -->\nApple rejected this release. See the attached notarization logs.\n\n" +
            arches.map((a) => a + ": " + result.macos[a].status).join("\n"),
        })
        errors.push(release.tag_name + ": Apple rejected the submission")
      } else if (result.ready) {
        ready.push(release.tag_name)
        if (command === "plan") {
          for (const arch of arches) {
            const log = await apple.log(result.macos[arch].id)
            await summary("Apple log for " + arch + ":\n" + JSON.stringify(log))
          }
          await writeFile(required("PLAN_FILE"), JSON.stringify({
            manifest: result.manifest, macos: result.macos,
          }, null, 2))
          for (const [key, value] of Object.entries({ source_sha: result.manifest.sourceSha,
            version: result.manifest.version, kind: result.manifest.kind, run_url: result.manifest.runUrl }))
            await output(key, value)
        }
      }
    } catch (error) {
      // API failures remain retryable; never turn a network failure into rejection.
      errors.push(release.tag_name + ": " + (error as Error).message)
    }
  }
  await output("ready", command === "plan" ? String(ready.length > 0) : JSON.stringify(ready))
  if (errors.length) {
    for (const error of errors) await summary("Release check error: " + error)
    if (command === "plan") throw new Error(errors.join("\n"))
    // Preserve the ready matrix even if another pending release has an error.
    await output("errors", "true")
  }
}

if (import.meta.main) await run(process.argv[2] ?? "")
