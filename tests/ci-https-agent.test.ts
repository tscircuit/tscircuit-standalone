import { afterAll, beforeAll, expect, test } from "bun:test"
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

let root: string
let certificate: string
let preload: string
let server: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ci https test "))
  certificate = join(root, "certificate.pem")
  const key = join(root, "key.pem")
  const config = join(root, "openssl.cnf")
  await writeFile(config, `[req]
distinguished_name=dn
x509_extensions=extensions
[dn]
CN=localhost
[extensions]
subjectAltName=DNS:localhost,IP:127.0.0.1
basicConstraints=critical,CA:TRUE
`)
  const generate = Bun.spawn([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-config", config, "-keyout", key, "-out", certificate,
  ], { stdout: "ignore", stderr: "pipe" })
  expect(await generate.exited, await new Response(generate.stderr).text()).toBe(0)
  preload = join(root, "preload with spaces.cjs")
  await copyFile(resolve("scripts/ci-https-agent.cjs"), preload)
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(certificate) },
    async fetch(request) {
      if (new URL(request.url).pathname === "/slow-redirect") {
        await Bun.sleep(6500)
        return new Response(null, { status: 302, headers: { location: "/binary" } })
      }
      return new Response("binary fixture")
    },
  })
})

afterAll(async () => {
  server?.stop(true)
  if (root) await rm(root, { recursive: true, force: true })
})

async function download(options: { preload?: boolean; timeout?: number; trustCertificate?: boolean } = {}) {
  const child = Bun.spawn(["node", "--input-type=module", "--eval", `
import https from "node:https"
import { readFileSync } from "node:fs"
const options = {}
if (process.env.TRUST_CERTIFICATE === "1") options.ca = readFileSync(process.env.TEST_CERTIFICATE)
if (process.env.REQUEST_TIMEOUT) options.timeout = Number(process.env.REQUEST_TIMEOUT)
const deadline = setTimeout(() => finish(new Error("Fixture deadline exceeded")), 15000)
function finish(error) {
  clearTimeout(deadline)
  https.globalAgent.destroy()
  if (error) { console.error(error.code || error.message); process.exitCode = 1 }
  else console.log("downloaded")
}
function get(url) {
  const request = https.get(url, options, response => {
    response.resume()
    if (response.statusCode === 302) get(new URL(response.headers.location, url))
    else response.on("end", () => finish())
  })
  request.on("timeout", () => request.destroy(new Error("HTTPS request timed out")))
  request.on("error", finish)
}
get(process.env.TEST_URL)
`], {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: options.preload ? `--require="${preload}"` : "",
      TEST_URL: `${server.url}slow-redirect`,
      TEST_CERTIFICATE: certificate,
      TRUST_CERTIFICATE: options.trustCertificate === false ? "0" : "1",
      REQUEST_TIMEOUT: options.timeout === undefined ? "" : String(options.timeout),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

test("CI dependency installs survive redirects beyond Node's default five-second timeout", async () => {
  const [original, fixed] = await Promise.all([download(), download({ preload: true })])
  expect(original.exitCode).toBe(1)
  expect(original.stderr).toContain("HTTPS request timed out")
  expect(fixed.exitCode, fixed.stderr).toBe(0)
  expect(fixed.stdout).toContain("downloaded")
}, 20000)

test("the CI agent still honors explicit shorter request timeouts", async () => {
  const result = await download({ preload: true, timeout: 30 })
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain("HTTPS request timed out")
}, 3000)

test("the CI agent still rejects untrusted TLS certificates", async () => {
  const result = await download({ preload: true, trustCertificate: false })
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toMatch(/SELF_SIGNED_CERT|UNABLE_TO_VERIFY/)
}, 3000)
