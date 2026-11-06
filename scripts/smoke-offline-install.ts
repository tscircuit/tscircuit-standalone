import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const binary = resolve(
  process.platform === "win32" ? "dist/tsci.exe" : "dist/tsci",
)
const directory = await mkdtemp(join(tmpdir(), "tsci-offline-smoke-"))
const trace = process.argv.includes("--trace")
let sequence = 0
const run = async (
  args: string[],
  { cwd = directory, success = true, allowLoopback = true } = {},
) => {
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
        ? {
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
          }
        : {}),
      PATH: directory,
      HOME: directory,
      TSCIRCUIT_CACHE_DIR: join(directory, "cache"),
      TSCIRCUIT_CONFIG_DIR: join(directory, "config"),
      TSCIRCUIT_DEFAULT_SEARCH_SOURCES: "ti,kicad,tscircuit",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  })
  const output = result.stdout.toString() + result.stderr.toString()
  assert.equal(result.exitCode === 0, success, `${args.join(" ")}: ${output}`)
  if (trace) {
    const calls = await readFile(tracePath, "utf8")
    if (!allowLoopback) {
      assert.doesNotMatch(
        calls,
        /^\d+\s+socket\(AF_INET6?,/m,
        `${args.join(" ")} opened an IP socket`,
      )
    }
    const outbound = calls
      .split("\n")
      .filter((line) =>
        /^\d+\s+(?:connect|sendto|sendmsg|sendmmsg)\(/.test(line),
      )
    const unexpected = outbound.filter(
      (line) =>
        !/\b(?:sendto|sendmsg|sendmmsg)\(\d+<UNIX-STREAM/.test(line) &&
        !(allowLoopback &&
          /inet_addr\("127\.[0-9.]+"\)|inet_pton\(AF_INET6, "(?:::1|::ffff:127\.[0-9.]+)"/.test(line)),
    )
    assert.deepEqual(
      unexpected,
      [],
      `${args.join(" ")} attempted ${allowLoopback ? "non-loopback " : ""}networking`,
    )
  }
  return output
}
try {
  const offlineSearch = { allowLoopback: false }
  const found = JSON.parse(
    await run(["search", "Rp2040", "--json"], offlineSearch),
  )
  assert.equal(found.query, "Rp2040")
  assert.equal(found.results[0]?.chip_name, "RP2040")
  assert.equal(found.results[0]?.source, "datasheets")
  assert.ok(found.results[0]?.datasheet_id)
  assert.match(
    await run(["search", "--datasheets", "rp204"], offlineSearch),
    /RP2040/,
  )
  const missing = "tsci-deliberately-unbundled-part"
  assert.deepEqual(
    JSON.parse(await run(["search", missing, "--json"], offlineSearch)),
    { query: missing, results: [] },
  )
  for (const source of ["ti", "kicad", "tscircuit"]) {
    assert.match(
      await run(["--", "search", "rp2040", `--${source}`], {
        ...offlineSearch,
        success: false,
      }),
      /Resource is not available from the configured platform source/,
    )
  }
  for (const source of ["digikey", "mouser", "jlcpcb", "lcsc"]) {
    assert.match(
      await run(["search", "tsci-deliberately-unbundled-part", `--${source}`], {
        ...offlineSearch,
        success: false,
      }),
      /Resource is not available from the configured platform source/,
    )
  }
  assert.match(
    await run(["help", "search"], offlineSearch),
    /TSCIRCUIT_DEFAULT_SEARCH_SOURCES/,
  )
  console.log(
    `Compiled search passed${trace ? " without opening any IP sockets" : ""}.`,
  )

  const initOutput = await run(["init", "project", "--yes"])
  const project = join(directory, "project")
  assert.ok(
    await Bun.file(
      join(project, "node_modules/tscircuit/package.json"),
    ).exists(),
    initOutput,
  )
  await rm(join(project, "node_modules"), { recursive: true })
  await run(["install"], { cwd: project })
  assert.ok(
    await Bun.file(
      join(project, "node_modules/tscircuit/package.json"),
    ).exists(),
  )
  await run(["install", "@types/react"], { cwd: project })
  const failedInstall = { cwd: project, success: false }
  assert.match(
    await run(
      ["install", "tsci-deliberately-uncached-fixture"],
      failedInstall,
    ),
    /--offline/,
  )
  await run(["install", "https://example.invalid/uncached.tgz"], failedInstall)
  await run(
    ["install", "git+https://example.invalid/uncached.git"],
    failedInstall,
  )
  assert.equal(existsSync(join(directory, "cache", "launchers")), false)
  console.log(
    `Compiled init/install/add passed with an empty package-manager PATH and a restored native cache${trace ? "; zero non-loopback connection/send attempts, including cache misses" : ""}.`,
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
