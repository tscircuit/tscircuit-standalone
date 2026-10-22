import { afterEach, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, verify } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appleToken, arches, manifestName, releaseFiles, run, teamId,
  type Manifest, type Plan,
} from "../scripts/release-queue"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
const key = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64")
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const tag = "manual-2026-10-22-123"
const sourceSha = "a".repeat(40)
const ids = { x64: "11111111-2222-3333-4444-555555555555", arm64: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }
const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-queue-"))
  roots.push(dir)
  const output = join(dir, "outputs")
  await writeFile(output, "")
  const files = new Map<string, Uint8Array>()
  const calls: { url: string; init?: RequestInit }[] = []
  const release: any = { id: 1, draft: true, tag_name: tag, target_commitish: sourceSha,
    name: "tscircuit standalone 0.0.3000", body: "", assets: [] }
  const status = new Map<string, string>(Object.values(ids).map((id) => [id, "In Progress"]))
  let statusError = 0, ancestor = true, uploadFailure = "", found = true
  const respond = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code })
  const request = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    const u = new URL(url), method = init?.method ?? "GET"
    if (u.hostname === "api.github.com") {
      if (u.pathname.includes("/compare/")) return respond({ status: ancestor ? "ahead" : "diverged" })
      if (u.pathname.endsWith("/releases") && method === "GET") return respond(found ? [release] : [])
      if (u.pathname.includes("/releases/tags/")) return found ? respond(release) : respond({}, 404)
      if (u.pathname.endsWith("/releases") && method === "POST") {
        Object.assign(release, JSON.parse(init!.body as string))
        found = true
        return respond(release, 201)
      }
      if (u.pathname.endsWith("/releases/1") && method === "PATCH") {
        Object.assign(release, JSON.parse(init!.body as string))
        return respond(release)
      }
      if (u.pathname.includes("/releases/assets/")) {
        const asset = release.assets.find((a: any) => String(a.id) === u.pathname.split("/").at(-1))
        if (!asset) return respond({}, 404)
        return new Response(files.get(asset.name) as BodyInit)
      }
    }
    if (u.hostname === "uploads.github.com") {
      const name = u.searchParams.get("name")!
      if (name === uploadFailure) return respond({}, 503)
      const asset = { id: release.assets.length + 1, name }
      release.assets.push(asset)
      files.set(name, new Uint8Array(init!.body as Uint8Array))
      return respond(asset, 201)
    }
    if (u.hostname === "appstoreconnect.apple.com") {
      if (statusError) return respond({}, statusError)
      const id = u.pathname.split("/")[4]!
      if (u.pathname.endsWith("/logs"))
        return respond({ data: { attributes: { developerLogUrl: "https://logs.apple.test/" + id } } })
      return respond({ data: { id, attributes: { status: status.get(id) } } })
    }
    if (u.hostname === "logs.apple.test") {
      expect(init?.headers).toBeUndefined()
      return respond({ issues: [], status: status.get(u.pathname.slice(1)) })
    }
    throw new Error("Unexpected request: " + method + " " + url)
  }
  const env = { GH_REPO: "fixture/standalone", GH_TOKEN: "fake-github-token",
    RELEASE_TAG: tag, RELEASE_VERSION: "0.0.3000", SOURCE_SHA: sourceSha,
    BUILD_KIND: "Manual", RUN_URL: "https://github.com/fixture/standalone/actions/runs/123",
    RELEASE_DIR: dir, PLAN_FILE: join(dir, "plan.json"), GITHUB_OUTPUT: output,
    APPLE_NOTARY_KEY_P8_BASE64: key, APPLE_NOTARY_KEY_ID: "FAKEKEY",
    APPLE_NOTARY_ISSUER_ID: "fake-issuer" }
  for (const name of releaseFiles) await writeFile(join(dir, name), "Fixture " + name)
  for (const arch of arches) {
    await writeFile(join(dir, "tsci-darwin-" + arch + ".notarization.json"), JSON.stringify({
      id: ids[arch], status: "In Progress", teamId,
      sha256: hash(await readFile(join(dir, "tsci-darwin-" + arch))),
    }))
  }
  const execute = async (command: string, changes: Record<string, string> = {}) => {
    await writeFile(output, "")
    await run(command, { ...env, ...changes }, request)
    return Object.fromEntries((await readFile(output, "utf8")).trim().split("\n")
      .filter(Boolean).map((line) => {
        const at = line.indexOf("=")
        return [line.slice(0, at), line.slice(at + 1)]
      }))
  }
  const stage = async () => {
    await execute("init")
    for (const arch of arches) await execute("save-macos", { ARCH: arch })
    await execute("seal")
  }
  const manifest = () => JSON.parse(new TextDecoder().decode(files.get(manifestName))) as Manifest
  const changeManifest = (change: (value: Manifest) => void) => {
    const value = manifest()
    change(value)
    files.set(manifestName, Buffer.from(JSON.stringify(value)))
  }
  return { dir, files, release, calls, status, env, execute, stage, manifest, changeManifest,
    failStatus: (code: number) => { statusError = code },
    failUpload: (name: string) => { uploadFailure = name },
    diverge: () => { ancestor = false },
    removeDraft: () => { found = false },
  }
}

test("Apple JWTs expire after ten minutes and carry a valid ES256 signature", () => {
  const token = appleToken(key, "FAKEKEY", "issuer", 1_000_000)
  const [header, payload, signature] = token.split(".")
  expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toMatchObject({ alg: "ES256", kid: "FAKEKEY" })
  expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
    iss: "issuer", iat: 1000, exp: 1600, aud: "appstoreconnect-v1",
  })
  expect(verify("sha256", Buffer.from(header + "." + payload),
    { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true)
})

test("submission and checking hand off through durable files; both architectures must be accepted", async () => {
  const f = await fixture()
  await f.stage()
  expect(f.manifest().files["tsci-darwin-x64"]).toBe(hash(f.files.get("tsci-darwin-x64")!))
  expect((await f.execute("scan")).ready).toBe("[]")
  f.status.set(ids.x64, "Accepted")
  expect((await f.execute("scan")).ready).toBe("[]")
  f.status.set(ids.arm64, "Accepted")
  expect(JSON.parse((await f.execute("scan")).ready!)).toEqual([tag])
  expect((await f.execute("plan")).ready).toBe("true")
  const destination = join(f.dir, "restored")
  await f.execute("download", { RELEASE_DIR: destination })
  for (const name of releaseFiles)
    expect(await readFile(join(destination, name))).toEqual(Buffer.from(f.files.get(name)!))
  const receipt = JSON.parse(await readFile(join(destination, "tsci-darwin-arm64.notarization.json"), "utf8"))
  expect(receipt).toMatchObject({ id: ids.arm64, status: "Accepted", teamId })
  expect(f.release.draft).toBe(true)
  expect(f.calls.some((c) => c.init?.method === "PATCH" &&
    JSON.parse(c.init.body as string).draft === false)).toBe(false)
})

test("initial submission creates a draft and the manifest is the final commit marker", async () => {
  const f = await fixture()
  f.removeDraft()
  await f.stage()
  const creation = f.calls.find((c) => c.init?.method === "POST" &&
    new URL(c.url).pathname.endsWith("/releases"))!
  expect(JSON.parse(creation.init!.body as string)).toMatchObject({
    tag_name: tag, target_commitish: sourceSha, draft: true, prerelease: true,
  })
  const mutations = f.calls.filter((c) => ["PATCH", "POST"].includes(c.init?.method ?? ""))
  expect(new URL(mutations.at(-1)!.url).searchParams.get("name")).toBe(manifestName)
})

test("a retry restores the existing submission without contacting Apple or changing signed bytes", async () => {
  const f = await fixture()
  await f.stage()
  const original = f.files.get("tsci-darwin-x64")!
  const callsBefore = f.calls.length
  expect((await f.execute("restore-macos", { ARCH: "x64", RELEASE_DIR: join(f.dir, "retry") })).reused).toBe("true")
  expect(await readFile(join(f.dir, "retry/tsci-darwin-x64"))).toEqual(Buffer.from(original))
  expect(f.calls.slice(callsBefore).some((c) => c.url.includes("apple.com"))).toBe(false)
  await f.execute("save-macos", { ARCH: "x64" })
  expect(f.files.get("tsci-darwin-x64")).toEqual(original)
})

test("an incomplete draft is never made discoverable to the checker", async () => {
  const f = await fixture()
  await f.execute("init")
  await f.execute("save-macos", { ARCH: "x64" })
  await expect(f.execute("seal")).rejects.toThrow("Missing draft asset")
  expect(f.files.has(manifestName)).toBe(false)
  expect((await f.execute("scan", { RELEASE_TAG: "" })).ready).toBe("[]")
})

test("a recovery artifact preserves the submission when the draft upload was interrupted", async () => {
  const f = await fixture()
  await f.execute("init")
  f.failUpload("tsci-darwin-x64.notarization.json")
  await expect(f.execute("save-macos", { ARCH: "x64" })).rejects.toThrow("Asset upload failed")
  expect(f.files.has("tsci-darwin-x64")).toBe(true)
  expect(f.files.has("tsci-darwin-x64.notarization.json")).toBe(false)
  expect((await f.execute("restore-macos", { ARCH: "x64" })).reused).toBe("true")
  f.failUpload("")
  await f.execute("save-macos", { ARCH: "x64" })
  const receipt = JSON.parse(new TextDecoder().decode(f.files.get("tsci-darwin-x64.notarization.json")))
  expect(receipt.id).toBe(ids.x64)
  expect(f.calls.some((c) => c.url.includes("apple.com"))).toBe(false)
})

test("network failures remain retryable and never become Apple rejection", async () => {
  const f = await fixture()
  await f.stage()
  f.failStatus(503)
  expect(await f.execute("scan")).toMatchObject({ ready: "[]", errors: "true" })
  expect(f.release.body).not.toContain("notarization-blocked")
  f.failStatus(0)
  for (const id of Object.values(ids)) f.status.set(id, "Accepted")
  expect((await f.execute("scan")).ready).toBe(JSON.stringify([tag]))
})

test("Apple rejection saves diagnostic logs and blocks publication", async () => {
  const f = await fixture()
  await f.stage()
  f.status.set(ids.x64, "Invalid")
  expect(await f.execute("scan")).toMatchObject({ ready: "[]", errors: "true" })
  expect(f.files.has("notarization-x64.log.json")).toBe(true)
  expect(f.release.body).toContain("notarization-blocked")
  const before = f.calls.length
  await f.execute("scan", { RELEASE_TAG: "" })
  expect(f.calls.slice(before).some((c) => c.url.includes("apple.com"))).toBe(false)
})

test("manifests from another commit, version, team or repository cannot reach finalization", async () => {
  for (const change of [
    (m: Manifest) => { m.sourceSha = "b".repeat(40) },
    (m: Manifest) => { m.version = "9.9.9" },
    (m: Manifest) => { m.macos.x64.teamId = "OTHERTEAM" },
    (m: Manifest) => { m.runUrl = "https://github.com/attacker/repo/actions/runs/123" },
    (m: Manifest) => { delete m.files["tsci-linux-x64"] },
    (m: Manifest) => { m.tag = "../../outside" },
  ]) {
    const f = await fixture()
    await f.stage()
    f.changeManifest(change)
    await expect(f.execute("plan")).rejects.toThrow()
  }
  const f = await fixture()
  await f.stage()
  f.diverge()
  await expect(f.execute("plan")).rejects.toThrow("ancestor of main")
})

test("changed saved files or receipt IDs cannot be downloaded as an accepted release", async () => {
  const f = await fixture()
  await f.stage()
  for (const id of Object.values(ids)) f.status.set(id, "Accepted")
  await f.execute("plan")
  f.files.set("tsci-linux-x64", Buffer.from("changed after submission"))
  await expect(f.execute("download")).rejects.toThrow("Saved asset changed")
  const plan: Plan = JSON.parse(await readFile(f.env.PLAN_FILE, "utf8"))
  plan.macos.x64.id = ids.arm64
  await writeFile(f.env.PLAN_FILE, JSON.stringify(plan))
  await expect(f.execute("download")).rejects.toThrow("Submission is not accepted")
})

test("immutable draft assets are not overwritten on a retry", async () => {
  const f = await fixture()
  await f.stage()
  await writeFile(join(f.dir, "tsci-darwin-x64"), "different signed executable")
  await expect(f.execute("save-macos", { ARCH: "x64" })).rejects.toThrow("checksum")
})

test("already published releases do not start another finalization", async () => {
  const f = await fixture()
  await f.stage()
  f.release.draft = false
  const before = f.calls.length
  expect((await f.execute("plan")).ready).toBe("false")
  expect(f.calls.slice(before).some((c) => c.url.includes("apple.com"))).toBe(false)
})
