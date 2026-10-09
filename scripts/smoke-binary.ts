import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const binary = resolve(process.platform === "win32" ? "dist/tsci.exe" : "dist/tsci")
const projectDir = await mkdtemp(join(tmpdir(), "tscircuit-standalone-"))
try {
  const run = (args: string[]) => Bun.spawnSync([binary, ...args], {
    cwd: projectDir,
    env: {
      PATH: projectDir,
      BUN_INSTALL_AUTO: "disable",
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
    },
    stdout: "pipe", stderr: "pipe",
  })
  const imported = run(["import", "C2040"])
  if (imported.exitCode !== 0) throw new Error(imported.stderr.toString())
  const source = await readFile(join(projectDir, "imports/C2040.tsx"), "utf8")
  if (!source.includes("qfn56_") || !source.includes("RP2040")) {
    throw new Error("Compiled binary did not emit the bundled RP2040 footprint")
  }
  if (/https?:\/\/.*\.(?:obj|step|glb)/.test(source)) {
    throw new Error("Generated component contains an external CAD asset")
  }
  const missing = run(["import", "C999999999"])
  if (missing.exitCode === 0 || !missing.stderr.toString().includes("C999999999")) {
    throw new Error("An unbundled part must fail with a useful local error")
  }
  const unsupported = run(["dev"])
  if (unsupported.exitCode === 0) throw new Error("Unimplemented commands must fail")
  console.log("Compiled binary imports C2040 with an empty project and no runtime on PATH; missing parts fail locally.")
} finally {
  await rm(projectDir, { recursive: true, force: true })
}
