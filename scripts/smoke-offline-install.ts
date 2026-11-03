import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const binary = resolve(
  process.platform === "win32" ? "dist/tsci.exe" : "dist/tsci",
)
const directory = await mkdtemp(join(tmpdir(), "tsci-offline-smoke-"))
const trace = process.argv.includes("--trace")
let sequence = 0
const run = async (args: string[], cwd = directory, success = true) => {
  const tracePath = join(directory, `network-${sequence++}.log`)
  const command = trace
    ? [
        "strace",
        "-f",
        "-yy",
        "-e",
        "trace=network",
        "-o",
        tracePath,
        binary,
        ...args,
      ]
    : [binary, ...args]
  // Resolve strace before restricting the child's PATH; no system Bun/npm is usable.
  if (trace)
    command[0] =
      Bun.which("strace") ??
      (() => {
        throw new Error("strace is required for --trace")
      })()
  const result = Bun.spawnSync(command, {
    cwd,
    env: {
      ...(process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP }
        : {}),
      PATH: directory,
      HOME: directory,
      TSCIRCUIT_CACHE_DIR: join(directory, "cache"),
      TSCIRCUIT_CONFIG_DIR: join(directory, "config"),
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  })
  const output = result.stdout.toString() + result.stderr.toString()
  assert.equal(result.exitCode === 0, success, `${args.join(" ")}: ${output}`)
  if (trace) {
    const calls = await readFile(tracePath, "utf8")
    const outbound = calls
      .split("\n")
      .filter((line) =>
        /^\d+\s+(?:connect|sendto|sendmsg|sendmmsg)\(/.test(line),
      )
    const unexpected = outbound.filter(
      (line) =>
        !/\b(?:sendto|sendmsg|sendmmsg)\(\d+<UNIX-STREAM/.test(line) &&
        !/inet_addr\("127\.[0-9.]+"\)|inet_pton\(AF_INET6, "(?:::1|::ffff:127\.[0-9.]+)"/.test(
          line,
        ),
    )
    assert.deepEqual(
      unexpected,
      [],
      `${args.join(" ")} attempted non-loopback networking`,
    )
  }
  return output
}
try {
  await run(["init", "project", "--yes"])
  const project = join(directory, "project")
  assert.ok(
    await Bun.file(
      join(project, "node_modules/tscircuit/package.json"),
    ).exists(),
  )
  await rm(join(project, "node_modules"), { recursive: true })
  await run(["install"], project)
  assert.ok(
    await Bun.file(
      join(project, "node_modules/tscircuit/package.json"),
    ).exists(),
  )
  await run(["install", "@types/react"], project)
  assert.match(
    await run(
      ["install", "tsci-deliberately-uncached-fixture"],
      project,
      false,
    ),
    /--offline/,
  )
  await run(["install", "https://example.invalid/uncached.tgz"], project, false)
  await run(
    ["install", "git+https://example.invalid/uncached.git"],
    project,
    false,
  )
  console.log(
    `Compiled init/install/add passed with an empty package-manager PATH and a restored native cache${trace ? "; zero non-loopback connection/send attempts, including cache misses" : ""}.`,
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
