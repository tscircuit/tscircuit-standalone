import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/** Test real embedded dependencies, a cold cache, and project-scoped shell routing. */
export async function smokeInternalBun(sourceBinary: string) {
  const directory = await mkdtemp(join(tmpdir(), "tsci bundled bun's runtime-"))
  const executableDirectory = join(directory, "tool's directory")
  const hostDirectory = join(directory, "host")
  const home = join(directory, "home")
  const project = join(directory, "project")
  const outside = join(directory, "outside")
  await Promise.all([executableDirectory, hostDirectory, home, outside].map(path => mkdir(path)))
  const binary = join(executableDirectory, process.platform === "win32" ? "tsci.exe" : "tsci")
  await copyFile(sourceBinary, binary)
  const marker = join(directory, "host-bun-was-used")
  await writeFile(join(hostDirectory, process.platform === "win32" ? "bun.cmd" : "bun"),
    process.platform === "win32" ? `@echo host-bun>"${marker}"\r\n@exit /b 99\r\n` : `#!/bin/sh\nprintf host-bun > '${marker.replaceAll("'", "'\\''")}'\nexit 99\n`, { mode: 0o755 })
  const requests: string[] = []
  const trap = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(request.url)
    return new Response("Network access must not be needed", { status: 500 })
  } })
  const env: Record<string, string | undefined> = {
    ...process.env, PATH: hostDirectory, HOME: home, USERPROFILE: home, TMPDIR: directory,
    TSCIRCUIT_CACHE_DIR: join(home, "cache"), BUN_INSTALL_CACHE_DIR: join(home, "unrelated-cache"),
    BUN_INSTALL_AUTO: "disable", npm_config_user_agent: "npm/10.0.0",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  }
  delete env.BUN_BE_BUN
  delete env.TSCIRCUIT_NODE_RUNTIME
  for (const key of Object.keys(env)) if (key !== "PATH" && key.toLowerCase() === "path") delete env[key]
  const execute = async (command: string[], cwd = directory) => {
    const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 180_000 })
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { status, stdout, stderr }
  }
  const run = async (args: string[], cwd = directory) => {
    const result = await execute([binary, ...args], cwd)
    assert.equal(result.status, 0, `${args.join(" ")}:\n${result.stdout}\n${result.stderr}`)
    return result.stdout
  }
  try {
    const version = (await run(["--version"])).trim()
    assert.equal((await run(["internal", "bun", "--version"])).trim(), "1.4.4")
    const initialized = await run(["init", "project", "--yes"])
    assert.match(initialized, /Dependencies installed successfully/)
    const installed = JSON.parse(await readFile(join(project, "node_modules/tscircuit/package.json"), "utf8"))
    assert.equal(installed.version, version)
    assert.ok(existsSync(join(project, "node_modules/@types/react/package.json")))
    assert.ok(existsSync(join(project, "bun.lock")))
    assert.equal(existsSync(marker), false, "Standalone invoked system Bun")
    await run(["add", "sucrase@3.35.1"], project)
    const manifestPath = join(project, "package.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    manifest.dependencies = { ...manifest.dependencies, fflate: "0.8.3" }
    await writeFile(manifestPath, JSON.stringify(manifest))
    await rm(join(project, "node_modules"), { recursive: true, force: true })
    // A plain install must stay offline even when .npmrc points at a live trap.
    await writeFile(join(project, ".npmrc"), `registry=${trap.url.origin}\n@tsci:registry=${trap.url.origin}\n`)
    const shell = process.platform === "win32" ? "powershell" : "bash"
    const integration = await run(["internal", "shell-init", shell])
    const nested = join(project, "nested")
    await mkdir(nested)
    let shellResult
    if (process.platform === "win32") {
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
      const script = join(directory, "manual.ps1")
      await writeFile(script, integration + `\nSet-Location ${quote(nested)}\nbun install\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\nWrite-Output MANUAL_INSTALL_OK\nSet-Location ${quote(outside)}\nbun --version\nexit $LASTEXITCODE\n`)
      const pwsh = Bun.which("pwsh")
      assert.ok(pwsh, "PowerShell is required for native shell qualification")
      shellResult = await execute([pwsh, "-NoProfile", "-File", script])
    } else {
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      shellResult = await execute(["/bin/bash", "-c", integration + `\ncd ${quote(nested)}\nbun install || exit $?\nprintf 'MANUAL_INSTALL_OK\\n'\ncd ${quote(outside)}\nbun --version\n`])
    }
    assert.equal(shellResult.status, 99, `${shellResult.stdout}\n${shellResult.stderr}`)
    assert.match(shellResult.stdout, /MANUAL_INSTALL_OK/)
    assert.ok(existsSync(marker), "The shell wrapper did not delegate to system Bun outside the project")
    assert.equal(JSON.parse(await readFile(join(project, "node_modules/fflate/package.json"), "utf8")).version, "0.8.3")
    const missing = await execute([binary, "internal", "bun", "add", "standalone-intentionally-uncached-package@1.0.0"], project)
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /offline|bundled cache/i)
    const urlMiss = await execute([binary, "internal", "bun", "add", `${trap.url.origin}/uncached.tgz`], project)
    assert.notEqual(urlMiss.status, 0)
    assert.deepEqual(requests, [], "A package operation attempted a network request")
    assert.equal((await run(["--version"])).trim(), version)
    console.log("Bundled cache: default init, add and manual shell install passed; cache misses made no requests; system Bun is preserved outside projects.")
  } finally {
    trap.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) await smokeInternalBun(resolve(process.argv[2] ?? (process.platform === "win32" ? "dist/tsci.exe" : "dist/tsci")))
