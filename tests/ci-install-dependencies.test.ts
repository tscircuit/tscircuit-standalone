import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(mode: string, version?: string) {
  const root = await mkdtemp(join(tmpdir(), "ci dependency install "))
  roots.push(root)
  await mkdir(join(root, "bin"))
  await mkdir(join(root, "package-cache"))
  await writeFile(join(root, "package.json"), "{}")
  await writeFile(join(root, "bun.lock"), "fixture")
  await writeFile(join(root, "package-cache", "keep"), "downloaded package")
  const fakeBun = join(root, "bin", "bun")
  await writeFile(fakeBun, `#!/usr/bin/env bash
set -eu
if [[ -n "\${EXPECTED_VERSION:-}" ]]; then
  [[ "$1" == scripts/prepare-release.ts && "$2" == "$EXPECTED_VERSION" ]]
else
  [[ "$1" == install && "$2" == --frozen-lockfile && $# == 2 ]]
fi
[[ "$NODE_OPTIONS" == *ci-https-agent.cjs* ]]
attempt=0
if [[ -f attempts ]]; then attempt="$(cat attempts)"; fi
attempt=$((attempt + 1))
echo "$attempt" > attempts
if [[ "$FIXTURE_MODE" == fatal ]]; then
  echo 'Invalid dependency manifest' >&2
  exit 23
fi
if [[ "$FIXTURE_MODE" == persistent || "$attempt" == 1 ]]; then
  mkdir -p node_modules ui/node_modules
  touch node_modules/failed-native-install ui/node_modules/failed-native-install
  echo 'prebuild-install warn install No prebuilt binaries found (runtime=napi)' >&2
  exit 23
fi
[[ ! -e node_modules/failed-native-install && ! -e ui/node_modules/failed-native-install ]]
[[ -f package-cache/keep ]]
mkdir -p node_modules
touch node_modules/native-install-complete
`)
  await chmod(fakeBun, 0o755)
  const child = Bun.spawn([
    "bash", resolve("scripts/ci-install-dependencies.sh"), ...(version ? [version] : []),
  ], {
    cwd: root,
    env: {
      ...process.env,
      PATH: join(root, "bin") + delimiter + process.env.PATH,
      FIXTURE_MODE: mode,
      EXPECTED_VERSION: version ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  return { root, exitCode, stdout, stderr, attempts: Number(await readFile(join(root, "attempts"), "utf8")) }
}

test("a native download failure gets a clean reinstall without discarding package downloads", async () => {
  const result = await fixture("transient")
  expect(result.exitCode, result.stdout + result.stderr).toBe(0)
  expect(result.attempts).toBe(2)
  expect(await Bun.file(join(result.root, "node_modules", "native-install-complete")).exists()).toBe(true)
}, 10000)

test("persistent download failures stop after three attempts with the install exit code", async () => {
  const result = await fixture("persistent")
  expect(result.exitCode).toBe(23)
  expect(result.attempts).toBe(3)
}, 10000)

test("non-network installation failures fail immediately", async () => {
  const result = await fixture("fatal")
  expect(result.exitCode).toBe(23)
  expect(result.attempts).toBe(1)
})

test("selected-release preparation uses the same download protection", async () => {
  const result = await fixture("transient", "0.0.3082")
  expect(result.exitCode, result.stdout + result.stderr).toBe(0)
  expect(result.attempts).toBe(2)
}, 10000)
