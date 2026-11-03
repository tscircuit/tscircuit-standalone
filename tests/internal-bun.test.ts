import { expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { bunCacheFixture } from "./bun-cache-fixture"

test("compiled internal Bun works without a host runtime and preserves process behavior", async () => {
  const directory = await mkdtemp(join(tmpdir(), "standalone bun's runtime-"))
  const fixture = await bunCacheFixture(directory)
  try {
    const project = join(directory, "project")
    await (await import("node:fs/promises")).mkdir(project)
    const entry = join(directory, "entry.ts")
    const binary = join(
      directory,
      process.platform === "win32" ? "fixture.exe" : "fixture",
    )
    await writeFile(
      entry,
      `
      import { getInternalBunArguments, getInternalBunCommandPrefix, runInternalBun } from ${JSON.stringify(resolve("lib/internal-bun.ts"))};
      const args = process.argv.slice(2);
      if (args[0] === "internal" && args[1] === "bun") process.exitCode = await runInternalBun(args.slice(2));
      else if (args[0] === "probe") {
        const child = Bun.spawnSync(getInternalBunArguments(["--version"]));
        process.stdout.write(child.stdout); process.exitCode = child.exitCode;
      } else if (args[0] === "environment") {
        await runInternalBun(["-e", "process.exit(0)"]);
        console.log(process.env.BUN_BE_BUN ?? "unset");
      } else if (args[0] === "prefix") console.log(getInternalBunCommandPrefix());
      else console.log("application mode");
    `,
    )
    const result = await Bun.build({
      entrypoints: [entry],
      compile: { outfile: binary },
      define: { TSCIRCUIT_STANDALONE_COMPILED: "true" },
      plugins: [{ name: "fixture-cache", setup(build) {
        build.onResolve({ filter: /generated-bun-cache$/ }, () => ({ path: "cache", namespace: "fixture" }))
        build.onLoad({ filter: /.*/, namespace: "fixture" }, () => {
          const assets = [fixture.bundle.archive, fixture.bundle.lockfile, ...Object.values(fixture.bundle.manifests)]
          return { contents: assets.map((path, i) => `import asset${i} from ${JSON.stringify(path)} with { type: "file" };`).join("\n") +
            `\nexport const bundledBunCache = { ...${JSON.stringify(fixture.bundle)}, archive: asset0, lockfile: asset1, manifests: {${Object.keys(fixture.bundle.manifests).map((name, i) => `${JSON.stringify(name)}: asset${i + 2}`).join(",")}} };`, loader: "js" }
        })
      } }],
    })
    expect(result.success).toBe(true)
    if (process.platform === "darwin")
      expect(
        Bun.spawnSync(["codesign", "--force", "--sign", "-", binary]).exitCode,
      ).toBe(0)
    const env = {
      PATH: "",
      HOME: directory,
      TMPDIR: directory,
      BUN_INSTALL_AUTO: "disable",
      BUN_INSTALL_CACHE_DIR: join(directory, "cache"),
      TSCIRCUIT_CACHE_DIR: join(directory, "private-cache"),
      ...(process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec }
        : {}),
    }
    const run = (args: string[], input?: string) =>
      Bun.spawnSync([binary, ...args], {
        cwd: project,
        env,
        stdin: input === undefined ? "ignore" : Buffer.from(input),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      })
    expect(run([]).stdout.toString()).toBe("application mode\n")
    const version = run(["internal", "bun", "--version"])
    expect(version.exitCode).toBe(0)
    expect(version.stdout.toString().trim()).toBe(Bun.version)
    expect(run(["probe"]).stdout.toString().trim()).toBe(Bun.version)
    const prefix = run(["prefix"]).stdout.toString().trim()
    expect(
      execSync(`${prefix} --version`, {
        cwd: directory,
        env,
        encoding: "utf8",
      }).trim(),
    ).toBe(Bun.version)
    expect(run(["environment"]).stdout.toString()).toBe("unset\n")
    await writeFile(
      join(project, "script.ts"),
      `console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),input:await Bun.stdin.text()}))`,
    )
    const args = ["with spaces", "quotes'\"", "--option=value"]
    const script = run(
      ["internal", "bun", "script.ts", ...args],
      "stdin payload",
    )
    expect(script.exitCode).toBe(0)
    const scriptOutput = JSON.parse(script.stdout.toString())
    // Windows can report an 8.3 alias for the same working directory.
    expect({ ...scriptOutput, cwd: await realpath(scriptOutput.cwd) }).toEqual({
      args,
      cwd: await realpath(project),
      input: "stdin payload",
    })
    const failure = run([
      "internal",
      "bun",
      "-e",
      'process.stderr.write("child error"); process.exit(37)',
    ])
    expect(failure.exitCode).toBe(37)
    expect(failure.stderr.toString()).toStartWith("child error")
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "consumer", private: true, scripts: { postinstall: "exit 99", reinstall: "bun install" } }),
    )
    const add = run([
      "internal",
      "bun",
      "add",
      "internal-bun-fixture",
    ])
    expect(add.exitCode, add.stderr.toString()).toBe(0)
    expect(
      JSON.parse(
        await readFile(
          join(project, "node_modules/internal-bun-fixture/package.json"),
          "utf8",
        ),
      ).version,
    ).toBe("1.0.0")
    await rm(join(project, "node_modules"), { recursive: true })
    const install = run([
      "internal",
      "bun",
      "install",
      "--offline",
      "--ignore-scripts",
    ])
    expect(install.exitCode, install.stderr.toString()).toBe(0)
    expect(
      run([
        "internal",
        "bun",
        "-e",
        'console.log(require("internal-bun-fixture"))',
      ]).stdout.toString(),
    ).toBe("17\n")
    await rm(join(project, "node_modules"), { recursive: true })
    const nestedInstall = run(["internal", "bun", "run", "reinstall"])
    expect(nestedInstall.exitCode, nestedInstall.stderr.toString()).toBe(0)
    const changedManifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"))
    changedManifest.dependencies = { ...changedManifest.dependencies, "script-only-cache-miss": "1.0.0" }
    await writeFile(join(project, "package.json"), JSON.stringify(changedManifest))
    const nestedMiss = run(["internal", "bun", "run", "reinstall"])
    expect(nestedMiss.exitCode).not.toBe(0)
    expect(nestedMiss.stderr.toString()).toContain("--offline")
    expect(fixture.requests).toEqual([])
    const missing = run(["internal", "bun", "add", "not-in-bundled-cache@1.0.0"])
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stderr.toString()).toContain("--offline")
    const missingTarball = run(["internal", "bun", "add", `${fixture.bundle.registry}/not-cached.tgz`])
    expect(missingTarball.exitCode).not.toBe(0)
    expect(fixture.requests).toEqual([])
    expect(run([]).stdout.toString()).toBe("application mode\n")
  } finally {
    fixture.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
