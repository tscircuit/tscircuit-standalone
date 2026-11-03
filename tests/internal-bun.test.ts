import { expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("compiled internal Bun works without a host runtime and preserves process behavior", async () => {
  const directory = await mkdtemp(join(tmpdir(), "standalone bun's runtime-"))
  try {
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
      ...(process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec }
        : {}),
    }
    const run = (args: string[], input?: string) =>
      Bun.spawnSync([binary, ...args], {
        cwd: directory,
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
      join(directory, "script.ts"),
      `console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),input:await Bun.stdin.text()}))`,
    )
    const args = ["with spaces", "quotes'\"", "--option=value"]
    const script = run(
      ["internal", "bun", "script.ts", ...args],
      "stdin payload",
    )
    expect(script.exitCode).toBe(0)
    expect(JSON.parse(script.stdout.toString())).toEqual({
      args,
      cwd: await realpath(directory),
      input: "stdin payload",
    })
    const failure = run([
      "internal",
      "bun",
      "-e",
      'process.stderr.write("child error"); process.exit(37)',
    ])
    expect(failure.exitCode).toBe(37)
    expect(failure.stderr.toString()).toBe("child error")
    const archive = new Bun.Archive({
      "package/package.json": JSON.stringify({
        name: "internal-bun-fixture",
        version: "1.0.0",
        main: "index.js",
      }),
      "package/index.js": "module.exports = 17\n",
    })
    await writeFile(
      join(directory, "fixture.tgz"),
      Bun.gzipSync(new Uint8Array(await (await archive.blob()).arrayBuffer())),
    )
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "consumer", private: true }),
    )
    const add = run([
      "internal",
      "bun",
      "add",
      "--offline",
      "--ignore-scripts",
      "./fixture.tgz",
    ])
    expect(add.exitCode, add.stderr.toString()).toBe(0)
    expect(
      JSON.parse(
        await readFile(
          join(directory, "node_modules/internal-bun-fixture/package.json"),
          "utf8",
        ),
      ).version,
    ).toBe("1.0.0")
    await rm(join(directory, "node_modules"), { recursive: true })
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
    expect(run([]).stdout.toString()).toBe("application mode\n")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
