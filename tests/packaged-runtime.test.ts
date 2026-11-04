import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { packDirectory } from "../scripts/pack-directory"

let root: string
let binary: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "packaged runtime "))
  const runtime = join(root, "runtime")
  const cli = join(runtime, "node_modules/fixture-cli")
  const dependency = join(runtime, "node_modules/fixture-dependency")
  await mkdir(cli, { recursive: true })
  await mkdir(dependency)
  await writeFile(join(runtime, "package.json"), JSON.stringify({
    name: "runtime-fixture", private: true, type: "module",
    dependencies: { "fixture-cli": "1.0.0", "fixture-dependency": "1.0.0" },
  }))
  await writeFile(join(dependency, "package.json"), JSON.stringify({
    name: "fixture-dependency", version: "1.0.0", type: "module", main: "index.js",
  }))
  await writeFile(join(dependency, "index.js"), "export const answer = 42\n")
  await symlink(dependency, join(runtime, "node_modules/fixture-alias"), "junction")
  await writeFile(join(cli, "package.json"), JSON.stringify({
    name: "fixture-cli", version: "1.0.0", type: "module", main: "index.js",
  }))
  await writeFile(join(cli, "asset.txt"), "unaltered package resource")
  await writeFile(join(cli, "worker.js"), 'import { answer } from "fixture-alias"; postMessage(answer)\n')
  await writeFile(join(cli, "index.js"), [
    'import { readFileSync } from "node:fs"',
    'import { pathToFileURL } from "node:url"',
    'import { resolve } from "node:path"',
    'import { answer } from "fixture-dependency"',
    'if (process.argv.includes("--fail")) process.exit(17)',
    'if (process.argv.includes("--project")) {',
    '  const { answer } = await import(pathToFileURL(resolve("project.mjs")).href)',
    '  console.log(JSON.stringify({ answer })); process.exit(0)',
    '}',
    'const worker = new Worker(new URL("./worker.js", import.meta.url).href)',
    'const value = await new Promise((resolve, reject) => { worker.onmessage = event => resolve(event.data); worker.onerror = reject })',
    'worker.terminate()',
    'console.log(JSON.stringify({ answer, worker: value, asset: readFileSync(new URL("./asset.txt", import.meta.url), "utf8"), args: process.argv.slice(2) }))',
  ].join("\n"))

  await writeFile(join(root, "project.mjs"), 'export { answer } from "fixture-dependency"')
  const project = join(root, "project")
  const projectDependency = join(project, "node_modules/fixture-dependency")
  await mkdir(projectDependency, { recursive: true })
  await writeFile(join(project, "project.mjs"), 'export { answer } from "fixture-dependency"')
  await writeFile(join(projectDependency, "package.json"), JSON.stringify({
    name: "fixture-dependency", version: "2.0.0", type: "module", main: "index.js",
  }))
  await writeFile(join(projectDependency, "index.js"), "export const answer = 84\n")
  await packDirectory(runtime, join(root, "runtime.tar.gz"))
  await writeFile(join(root, "entry.ts"), [
    'import archive from "./runtime.tar.gz" with { type: "file" }',
    "import { restorePackagedRuntime, runPackagedCli } from " + JSON.stringify(resolve("lib/packaged-runtime.ts")),
    "const entrypoint = await restorePackagedRuntime({ archive, id: 'fixture', bunVersion: " + JSON.stringify(Bun.version) + ", entrypoint: 'node_modules/fixture-cli/index.js' })",
    "process.exit(await runPackagedCli(entrypoint))",
  ].join("\n"))
  binary = join(root, process.platform === "win32" ? "tsci.exe" : "tsci")
  const build = await Bun.build({ entrypoints: [join(root, "entry.ts")], compile: { outfile: binary } })
  expect(build.success, String(build.logs)).toBe(true)
  if (process.platform === "darwin") expect(Bun.spawnSync(["codesign", "--force", "--sign", "-", binary]).exitCode).toBe(0)
}, 60_000)

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function run(args: string[], cwd = root) {
  const child = Bun.spawn([binary, ...args], {
    cwd,
    env: { ...process.env, PATH: "", TSCIRCUIT_CACHE_DIR: join(root, "restored"), TSCIRCUIT_NODE_RUNTIME_ARGS: "[]" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, stdout, stderr }
}

test("restored packages retain filesystem assets, dependency links, workers and literal arguments", async () => {
  const args = ["space in argument", "literal;$value", "$(not-a-command)", "--option=value"]
  const result = await run(args)
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ answer: 42, worker: 42, asset: "unaltered package resource", args })
})

test("the packaged CLI exit code is preserved", async () => {
  const result = await run(["--fail"])
  expect(result.code, result.stderr).toBe(17)
})

test("uninstalled project imports use the packaged dependency graph", async () => {
  const result = await run(["--project"])
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ answer: 42 })
})

test("project-local dependencies take priority over the packaged fallback", async () => {
  const result = await run(["--project"], join(root, "project"))
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ answer: 84 })
})
