import { expect, test } from "bun:test"
import { embedCliEvalWorker, inlineCliDependencyVersions, routeCliBunCalls } from "../scripts/cli-package-adapters"

test("published CLI worker embedding preserves the surrounding JavaScript and asset quoting", () => {
  const asset =
    'const worker = "<--INJECT_TSCIRCUIT_EVAL_WEB_WORKER_BLOB_URL-->"; const label = "user\'s circuit";'
  const literal = `'${asset.replaceAll("'", "\\'")}'`
  const source = `const before = 1; var standalone_min_default = ${literal}; const after = 2;`
  const embedded = embedCliEvalWorker(source, "d29ya2Vy")
  const result = new Function(
    `${embedded}; return { asset: standalone_min_default, before, after };`,
  )()
  expect(result.before).toBe(1)
  expect(result.after).toBe(2)
  expect(result.asset).toContain('atob("d29ya2Vy")')
  expect(result.asset).toContain("user's circuit")
  expect(result.asset).not.toContain("<--INJECT_")
})

test("standalone routes Bun operations while preserving other package managers and metadata", () => {
  const source = `
    function detectPackageManager() { return Bun.spawnSync(["bun", "--version"], { stdout: "ignore" }).exitCode; }
    function getPackageManager(name) {
      return [\`bun remove \${name}\`, \`bun add \${name}\`, \`bun update \${name}\`,
        "bun init -y", "bun install", \`bun add -d \${name}\`, \`bun add \${name}\`, "npm install"];
    }
    var getGlobalDepsInstallCommand = (deps) => \`bun install -g \${deps}\`;
    const metadata = { scripts: { build: "bun build index.ts" } };
    return { commands: getPackageManager("fixture"), global: getGlobalDepsInstallCommand("agent"), probe: detectPackageManager(), metadata };
  `
  const routed = routeCliBunCalls(source, true)
  const spawn = (args: string[]) => {
    expect(args).toEqual(["/standalone", "internal", "bun", "--version"])
    return { exitCode: 0 }
  }
  const result = new Function("__standaloneBunCommand", "__standaloneBunArguments", "Bun", routed.source)(
    () => "'/standalone' internal bun",
    (args: string[]) => ["/standalone", "internal", "bun", ...args],
    { spawnSync: spawn },
  )
  expect(routed.usesRuntime).toBe(true)
  expect(result.commands).toEqual([
    "'/standalone' internal bun remove fixture", "'/standalone' internal bun add fixture",
    "'/standalone' internal bun update fixture", "'/standalone' internal bun init -y",
    "'/standalone' internal bun install", "'/standalone' internal bun add -d fixture",
    "'/standalone' internal bun add fixture", "npm install",
  ])
  expect(result.global).toBe("'/standalone' internal bun install -g agent")
  expect(result.metadata.scripts.build).toBe("bun build index.ts")
  expect(result.probe).toBe(0)
  expect(() => routeCliBunCalls("function renamedManager() {}", true)).toThrow("has changed")
  expect(() => routeCliBunCalls("function getPackageManager() {}", true)).toThrow("have changed")
})

test("changed published CLI asset layouts fail during the build", () => {
  expect(() => embedCliEvalWorker("const unrelated = 1", "")).toThrow(
    "asset is missing",
  )
  expect(() =>
    embedCliEvalWorker('var standalone_min_default = "changed";', ""),
  ).toThrow("placeholder is missing")
})

test("CLI dependency versions are embedded without invoking runtime package resolution", async () => {
  const source = `
    function getTscircuitDependencyVersion() { throw new Error("No node_modules") }
    const label = 'getTscircuitDependencyVersion("unrelated")';
    return [getTscircuitDependencyVersion("@tscircuit/eval"),
      getTscircuitDependencyVersion("@tscircuit/runframe"), label];
  `
  const versions: Record<string, string> = {
    "@tscircuit/eval": "1.2.3",
    "@tscircuit/runframe": "4.5.6",
  }
  const getVersion = async (name: string) => versions[name]!
  const embedded = await inlineCliDependencyVersions(source, getVersion)
  expect(new Function(embedded)()).toEqual([
    "1.2.3", "4.5.6", 'getTscircuitDependencyVersion("unrelated")',
  ])
  await expect(inlineCliDependencyVersions("getTscircuitDependencyVersion(name)", getVersion))
    .rejects.toThrow("literal package name")
  await expect(inlineCliDependencyVersions('getTscircuitDependencyVersion("missing")', getVersion))
    .rejects.toThrow("Missing installed version")
})
