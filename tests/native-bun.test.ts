import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  symlink,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { packDirectory } from "../scripts/pack-directory"

let root: string
let binary: string
let server: ReturnType<typeof Bun.serve>
let requests = 0
let counter = 0

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "native-bun-test-"))
  const tarball = await new Bun.Archive(
    {
      "package/package.json": JSON.stringify({
        name: "tsci-cache-fixture",
        version: "1.0.0",
        scripts: { postinstall: "echo ran > lifecycle-ran" },
      }),
      "package/index.js": "export const answer = 42\n",
      "package/LICENSE": "Fixture license\n",
    },
    { compress: "gzip" },
  ).bytes()
  server = Bun.serve({
    port: 0,
    fetch(request) {
      requests++
      if (new URL(request.url).pathname.endsWith(".tgz"))
        return new Response(tarball)
      return Response.json({
        name: "tsci-cache-fixture",
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: "tsci-cache-fixture",
            version: "1.0.0",
            dist: { tarball: `${server.url}fixture.tgz` },
          },
        },
      })
    },
  })
  const seed = join(root, "seed")
  await mkdir(seed)
  await writeFile(
    join(seed, "package.json"),
    JSON.stringify({ dependencies: { "tsci-cache-fixture": "1.0.0" } }),
  )
  const warm = Bun.spawn(
    [
      process.execPath,
      "install",
      "--ignore-scripts",
      `--registry=${server.url}`,
    ],
    {
      cwd: seed,
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(root, "warm-cache") },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  expect(await warm.exited, await new Response(warm.stderr).text()).toBe(0)
  // Exercise the alias/canonical-path mismatch found in macOS temp directories
  // and Windows junctions, even when this test runs on Linux.
  await symlink(join(root, "warm-cache"), join(root, "cache-alias"), "junction")
  await packDirectory(join(root, "cache-alias"), join(root, "cache.tar.gz"))
  const metadata = JSON.parse(
    await readFile(join(root, "cache.tar.gz.notices.json"), "utf8"),
  )
  expect(metadata[0].notices[0].content).toContain("Fixture license")
  const nativeModule = JSON.stringify(resolve("lib/native-bun.ts"))
  await writeFile(
    join(root, "entry.ts"),
    `import { setupNativeBun } from ${nativeModule}
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import archive from './cache.tar.gz' with { type: 'file' }
const originalPath = process.env.PATH
const originalAgent = process.env.npm_config_user_agent
const configDirectory = await mkdtemp(join(tmpdir(), 'tsci-config-'))
await setupNativeBun({ archive, id:'fixture', bunVersion:${JSON.stringify(Bun.version)} }, configDirectory)
if (process.env.PATH !== originalPath || process.env.npm_config_user_agent !== originalAgent || process.env.BUN_BE_BUN) throw Error('Parent environment changed')
const child = Bun.spawn([process.env.TSCIRCUIT_NODE_RUNTIME, ...JSON.parse(process.env.TSCIRCUIT_NODE_RUNTIME_ARGS), ...process.argv.slice(2)], {
  env: { ...process.env, BUN_BE_BUN:'1' }, stdin:'inherit', stdout:'inherit', stderr:'inherit'
})
process.exitCode = await child.exited
await rm(configDirectory, { recursive:true, force:true })
`,
  )
  binary = join(root, process.platform === "win32" ? "tsci.exe" : "tsci")
  const build = await Bun.build({
    entrypoints: [join(root, "entry.ts")],
    compile: { outfile: binary },
  })
  expect(build.success, String(build.logs)).toBe(true)
  if (process.platform === "darwin") {
    const signing = Bun.spawnSync([
      "codesign",
      "--force",
      "--sign",
      "-",
      binary,
    ])
    expect(signing.exitCode).toBe(0)
  }
  // The executable invokes its embedded Bun directly, even with no Bun on PATH.
  const setup = Bun.spawn([binary, "--version"], {
    env: {
      ...process.env,
      PATH: "",
      TSCIRCUIT_CACHE_DIR: join(root, "restored-cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(await setup.exited, await new Response(setup.stderr).text()).toBe(0)
  expect((await new Response(setup.stdout).text()).trim()).toBe(Bun.version)
  requests = 0
}, 60_000)

afterAll(async () => {
  server?.stop(true)
  if (root) await rm(root, { recursive: true, force: true })
})

async function run(
  args: string[],
  dependencies: Record<string, string> = { "tsci-cache-fixture": "latest" },
  extra: Record<string, unknown> = {},
) {
  const cwd = join(root, `project-${counter++}`)
  await mkdir(cwd)
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ dependencies, ...extra }),
  )
  await writeFile(join(cwd, ".npmrc"), `registry=${server.url}\n`)
  await writeFile(
    join(cwd, "bunfig.toml"),
    "[install]\noffline = false\nignoreScripts = false\n",
  )
  const child = Bun.spawn([binary, ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: "",
      TSCIRCUIT_CACHE_DIR: join(root, "restored-cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(requests).toBe(0)
  return { code, stdout, stderr, cwd }
}

test("native offline install restores package and manifest caches without registry requests", async () => {
  const result = await run(["install"])
  expect(result.code, result.stderr).toBe(0)
  expect(
    await Bun.file(
      join(result.cwd, "node_modules/tsci-cache-fixture/index.js"),
    ).text(),
  ).toContain("42")
})

test("cache links to a different directory are still rejected", async () => {
  const cache = join(root, "escaping-cache")
  await mkdir(cache)
  await symlink(join(root, "seed"), join(cache, "outside"), "junction")
  await expect(
    packDirectory(cache, join(root, "escaping.tar.gz")),
  ).rejects.toThrow("Cache link escapes the cache")
})

test("native add and remove use the same offline cache", async () => {
  const add = await run(["add", "tsci-cache-fixture@1.0.0"], {})
  expect(add.code, add.stderr).toBe(0)
  const remove = await run(["remove", "tsci-cache-fixture"])
  expect(remove.code, remove.stderr).toBe(0)
})

test("missing packages, versions and URLs fail locally", async () => {
  const missing = await run(["add", "tsci-cache-missing"], {})
  expect(missing.code).toBe(1)
  expect(missing.stderr).toContain("--offline")
  const version = await run(["add", "tsci-cache-fixture@9.0.0"], {})
  expect(version.code).toBe(1)
  const url = await run(["add", `${server.url}uncached.tgz`], {})
  expect(url.code).toBe(1)
  const git = await run(["add", "git+https://example.invalid/uncached.git"], {})
  expect(git.code).toBe(1)
  expect(git.stderr).toContain("--offline")
})

test("lifecycle scripts cannot make their own outbound requests", async () => {
  const result = await run(
    ["install"],
    { "tsci-cache-fixture": "latest" },
    {
      scripts: { postinstall: "echo ran > lifecycle-ran" },
      trustedDependencies: ["tsci-cache-fixture"],
    },
  )
  expect(result.code, result.stderr).toBe(0)
  expect(await Bun.file(join(result.cwd, "lifecycle-ran")).exists()).toBe(false)
  expect(
    await Bun.file(
      join(result.cwd, "node_modules/tsci-cache-fixture/lifecycle-ran"),
    ).exists(),
  ).toBe(false)
})
