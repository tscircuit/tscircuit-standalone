import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/** Qualify the compiled CLI with no usable system Bun, using a local registry. */
export async function smokeInternalBun(sourceBinary: string) {
  const directory = await mkdtemp(join(tmpdir(), "tsci bundled bun's runtime-"))
  const executableDirectory = join(directory, "tool's directory")
  const hostDirectory = join(directory, "host")
  const home = join(directory, "home")
  const project = join(directory, "project")
  await Promise.all(
    [executableDirectory, hostDirectory, home, project].map((path) =>
      mkdir(path),
    ),
  )
  const binary = join(
    executableDirectory,
    process.platform === "win32" ? "tsci.exe" : "tsci",
  )
  await copyFile(sourceBinary, binary)
  const marker = join(directory, "host-bun-was-used")
  await writeFile(
    join(hostDirectory, process.platform === "win32" ? "bun.cmd" : "bun"),
    process.platform === "win32"
      ? `@echo host-bun>"${marker}"\r\n@exit /b 99\r\n`
      : `#!/bin/sh\nprintf host-bun > '${marker.replaceAll("'", "'\\''")}'\nexit 99\n`,
    { mode: 0o755 },
  )
  const packages = ["tscircuit", "@types/react", "standalone-runtime-fixture"]
  const archives = new Map<string, Uint8Array>()
  for (const name of packages) {
    const archive = new Bun.Archive({
      "package/package.json": JSON.stringify({
        name,
        version: "1.0.0",
        main: "index.js",
      }),
      "package/index.js": "module.exports = 17\n",
    })
    archives.set(
      name,
      Bun.gzipSync(new Uint8Array(await (await archive.blob()).arrayBuffer())),
    )
  }
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(url.pathname)
      if (url.pathname.startsWith("/tarballs/")) {
        const name = decodeURIComponent(
          url.pathname.slice("/tarballs/".length, -4),
        )
        const archive = archives.get(name)
        return archive
          ? new Response(new Uint8Array(archive), {
              headers: { "Content-Type": "application/octet-stream" },
            })
          : new Response("Missing fixture", { status: 404 })
      }
      const name = decodeURIComponent(url.pathname.slice(1))
      if (!archives.has(name))
        return new Response("Unexpected package", { status: 404 })
      return Response.json({
        name,
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name,
            version: "1.0.0",
            dist: {
              tarball: `${url.origin}/tarballs/${encodeURIComponent(name)}.tgz`,
            },
          },
        },
      })
    },
  })
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: hostDirectory,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: directory,
    BUN_INSTALL_CACHE_DIR: join(directory, "cache"),
    BUN_INSTALL_AUTO: "disable",
    npm_config_user_agent: "",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  }
  delete env.BUN_BE_BUN
  delete env.TSCIRCUIT_NODE_RUNTIME
  for (const key of Object.keys(env))
    if (key !== "PATH" && key.toLowerCase() === "path") delete env[key]
  const run = async (args: string[], cwd = directory) => {
    const child = Bun.spawn([binary, ...args], {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    })
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    assert.equal(status, 0, `${args.join(" ")}:\n${stdout}\n${stderr}`)
    return stdout
  }
  try {
    const applicationVersion = (await run(["--version"])).trim()
    const bunVersion = (await run(["internal", "bun", "--version"])).trim()
    assert.match(bunVersion, /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/)
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "bundled-bun-project", private: true }),
    )
    await writeFile(join(project, ".npmrc"), `registry=${server.url.origin}\n`)
    const initialized = await run(["init", "project", "--yes"])
    assert.match(initialized, /Dependencies installed successfully/)
    for (const name of ["tscircuit", "@types/react"]) {
      const installed = JSON.parse(
        await readFile(
          join(project, "node_modules", name, "package.json"),
          "utf8",
        ),
      )
      assert.equal(installed.version, "1.0.0")
    }
    assert.ok(existsSync(join(project, "bun.lock")))
    await run(
      ["add", `${server.url.origin}/tarballs/standalone-runtime-fixture.tgz`],
      project,
    )
    assert.equal(
      JSON.parse(
        await readFile(
          join(project, "node_modules/standalone-runtime-fixture/package.json"),
          "utf8",
        ),
      ).version,
      "1.0.0",
    )
    assert.equal(existsSync(marker), false, "Standalone invoked the system Bun")
    assert.equal((await run(["--version"])).trim(), applicationVersion)
    assert.ok(requests.includes("/tscircuit"))
    assert.ok(
      requests.some((path) => decodeURIComponent(path) === "/@types/react"),
    )
    console.log(
      `Bundled Bun ${bunVersion}: default init and add passed using only the local registry and no host runtime.`,
    )
  } finally {
    server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const binary =
    process.argv[2] ??
    (process.platform === "win32" ? "dist/tsci.exe" : "dist/tsci")
  await smokeInternalBun(resolve(binary))
}
