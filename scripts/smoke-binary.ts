import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
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
  await cp(resolve(import.meta.dir, "../examples"), join(projectDir, "examples"), { recursive: true })
  for (const name of ["led-resistor", "rp2040-breakout", "supplier-footprint"]) {
    const built = run(["build", `examples/${name}.circuit.tsx`])
    if (built.exitCode !== 0) throw new Error(built.stderr.toString())
    const json = JSON.parse(await readFile(join(projectDir, `build/${name}.circuit.json`), "utf8"))
    if (!json.some((element: { type: string }) => element.type === "pcb_trace")) {
      throw new Error(`${name} produced no routed PCB traces`)
    }
    const svg = await readFile(join(projectDir, `build/${name}.circuit.schematic.svg`), "utf8")
    if (!svg.includes("data-schematic-component-id")) {
      throw new Error(`${name} produced an empty schematic preview`)
    }
  }
  // Exercise the normal import -> src build workflow, using the component the
  // compiled executable just generated rather than the checked-in fixture.
  await mkdir(join(projectDir, "src"))
  const importedCircuit = (await readFile(join(projectDir, "examples/rp2040-breakout.circuit.tsx"), "utf8"))
    .replace('"./helpers/pad-testpoint"', '"../examples/helpers/pad-testpoint"')
    .replace('"./imports/C2040"', '"../imports/C2040"')
  await writeFile(join(projectDir, "src/imported-rp2040.circuit.tsx"), importedCircuit)
  const importedBuild = run(["build", "src/imported-rp2040.circuit.tsx"])
  if (importedBuild.exitCode !== 0) throw new Error(importedBuild.stderr.toString())
  const importedJson = JSON.parse(await readFile(join(projectDir, "build/imported-rp2040.circuit.json"), "utf8"))
  if (importedJson.filter((element: { type: string }) => element.type === "pcb_smtpad").length !== 72) {
    throw new Error("Generated RP2040 import did not preserve the fixture's pads")
  }
  await writeFile(join(projectDir, "missing-module.tsx"), `import Missing from 'unbundled-example-package'; export default Missing`)
  const missingModule = run(["build", "missing-module.tsx", "--output-dir", "missing-output"])
  if (missingModule.exitCode === 0) throw new Error("Missing dependencies must fail locally")
  await writeFile(join(projectDir, "remote-footprint.tsx"), `export default () => <board width="10mm" height="10mm"><chip name="U1" footprint="https://example.invalid/footprint.json"/></board>`)
  const remote = run(["build", "remote-footprint.tsx", "--output-dir", "remote-output"])
  if (remote.exitCode === 0) throw new Error("Remote footprints must fail locally")
  const files = await readdir(projectDir)
  if (files.includes("node_modules") || files.includes("missing-output") || files.includes("remote-output")) {
    throw new Error("Build created a dependency install or partial failure output")
  }
  console.log("Compiled binary imports C2040 and builds all three circuits without node_modules, tokens, or a runtime on PATH; missing modules and remote footprints fail locally.")
} finally {
  await rm(projectDir, { recursive: true, force: true })
}
