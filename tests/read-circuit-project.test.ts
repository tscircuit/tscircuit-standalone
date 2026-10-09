import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { readCircuitProject } from "../lib/read-circuit-project"
import { createStandalonePlatformConfig } from "../lib/platform"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function createProject(
  files: Record<string, string>,
  parentDirectory = os.tmpdir(),
): Promise<string> {
  const directory = await mkdtemp(
    path.join(parentDirectory, "standalone-project-"),
  )
  temporaryDirectories.push(directory)
  for (const [filePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(directory, filePath)
    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, contents)
  }
  return directory
}

describe("standalone circuit source graph", () => {
  test("collects only reachable modules, directory indexes, JSX and JSON", async () => {
    const directory = await createProject({
      "index.circuit.tsx": `import { Child } from './child'; import settings from './settings.json'; export default () => <Child value={settings.value} />`,
      "child/index.jsx": `export { Child } from './child'`,
      "child/child.jsx": `export const Child = () => <resistor name="R1" resistance="1k" footprint="0402" />`,
      "settings.json": `{"value": 123}`,
      "unused.ts": `import 'https://example.com/not-reachable'`,
    })
    const project = await readCircuitProject(
      path.join(directory, "index.circuit.tsx"),
    )
    expect(project.mainComponentPath).toBe("module-0000.tsx")
    expect(Object.keys(project.fsMap)).toHaveLength(4)
    expect(project.fsMap[project.mainComponentPath]).toContain(
      '"./module-0001.tsx"',
    )
    expect(project.fsMap[project.mainComponentPath]).toContain(
      '"./module-0002.json"',
    )
    expect(project.fsMap["module-0001.tsx"]).toContain('"./module-0003.tsx"')
    expect(project.fsMap["module-0002.json"]).toBe('{"value": 123}')
    expect(Object.values(project.fsMap).join("\n")).not.toContain(
      "not-reachable",
    )
  })

  test("keeps identical local specifiers in different directories distinct", async () => {
    const directory = await createProject({
      "index.tsx": `import { A } from './a/A'; import { B } from './b/B'; export default () => <board><A /><B /></board>`,
      "a/A.tsx": `import { Shared } from './Shared'; export const A = () => <Shared name="R1" />`,
      "a/Shared.tsx": `export const Shared = () => <resistor resistance="1k" />`,
      "b/B.tsx": `import { Shared } from './Shared'; export const B = () => <Shared name="R2" />`,
      "b/Shared.tsx": `export const Shared = () => <resistor resistance="2k" />`,
    })
    const { fsMap } = await readCircuitProject(
      path.join(directory, "index.tsx"),
    )
    expect(fsMap["module-0001.tsx"]).toContain('"./module-0003.tsx"')
    expect(fsMap["module-0002.tsx"]).toContain('"./module-0004.tsx"')
    expect(fsMap["module-0003.tsx"]).toContain('resistance="1k"')
    expect(fsMap["module-0004.tsx"]).toContain('resistance="2k"')
  })

  test("uses an explicit project root for src entries and sibling generated imports", async () => {
    const directory = await createProject({
      "src/index.tsx": `import { RP2040 } from '../imports/C2040'; export default () => <board><RP2040 name="U1" /></board>`,
      "imports/C2040.tsx": `export const RP2040 = () => <chip name="U1" />`,
    })
    const { fsMap, mainComponentPath } = await readCircuitProject(
      path.join(directory, "src/index.tsx"),
      { projectDir: directory },
    )
    expect(Object.keys(fsMap)).toHaveLength(2)
    expect(fsMap[mainComponentPath]).toContain(
      "Standalone source: src/index.tsx",
    )
    expect(fsMap["module-0001.tsx"]).toContain(
      "Standalone source: imports/C2040.tsx",
    )
    await expect(
      readCircuitProject(path.join(directory, "src/index.tsx"), {
        projectDir: path.join(directory, "src"),
      }),
    ).rejects.toThrow("escapes the circuit project directory")
  })

  test("uses cwd as the default root when the entry lies inside cwd", async () => {
    const directory = await createProject(
      {
        "src/index.tsx": `import { Child } from '../imports/Child'; export default () => <Child />`,
        "imports/Child.tsx": `export const Child = () => <board />`,
      },
      process.cwd(),
    )
    const { fsMap } = await readCircuitProject(
      path.join(directory, "src/index.tsx"),
    )
    expect(Object.keys(fsMap)).toHaveLength(2)
  })

  test("requires explicit project roots to contain the entry", async () => {
    const directory = await createProject({
      "index.tsx": `export default () => <board />`,
    })
    const outside = await createProject({})
    await expect(
      readCircuitProject(path.join(directory, "index.tsx"), {
        projectDir: outside,
      }),
    ).rejects.toThrow("escapes the circuit project directory")
  })

  for (const [specifierExtension, sourceExtension] of [
    [".js", ".ts"],
    [".js", ".tsx"],
    [".jsx", ".tsx"],
    [".jsx", ".ts"],
    [".mjs", ".mts"],
    [".cjs", ".cts"],
  ]) {
    test(`resolves ${specifierExtension} import specifiers to ${sourceExtension} sources`, async () => {
      const directory = await createProject({
        "index.ts": `import value from './value${specifierExtension}'; export default value`,
        [`value${sourceExtension}`]: `export default 123`,
      })
      const { fsMap } = await readCircuitProject(
        path.join(directory, "index.ts"),
      )
      expect(Object.keys(fsMap)).toHaveLength(2)
      expect(Object.values(fsMap).join("\n")).toContain(
        `Standalone source: value${sourceExtension}`,
      )
      expect(Object.values(fsMap).join("\n")).toContain("export default 123")
    })
  }

  test("prefers an existing exact JavaScript file over extension substitution", async () => {
    const directory = await createProject({
      "index.ts": `import value from './value.js'; export default value`,
      "value.js": `export default 'exact JavaScript'`,
      "value.ts": `export default 'substituted TypeScript'`,
    })
    const { fsMap } = await readCircuitProject(path.join(directory, "index.ts"))
    expect(Object.values(fsMap).join("\n")).toContain("exact JavaScript")
    expect(Object.values(fsMap).join("\n")).not.toContain(
      "substituted TypeScript",
    )
  })

  test("preloads Unicode import bindings that eval's regex scanner misses", async () => {
    const directory = await createProject({
      "index.tsx": `import Ω from './value'; export default () => <board width="10mm" height="10mm"><resistor name="R1" resistance={Ω} footprint="0402" /></board>`,
      "value.ts": `export default '4.7k'`,
    })
    const project = await readCircuitProject(path.join(directory, "index.tsx"))
    expect(project.fsMap[project.mainComponentPath]).toContain(
      'import "./module-0001.ts";',
    )
    expect(project.fsMap[project.mainComponentPath]).toContain(
      'import Ω from "./module-0001.ts"',
    )
    const { CircuitRunner } = await import("@tscircuit/eval/eval")
    const runner = new CircuitRunner({
      platform: createStandalonePlatformConfig(),
    })
    await runner.setDisableCdnLoading(true)
    await runner.executeWithFsMap(project)
    await runner.renderUntilSettled()
    const resistor = (await runner.getCircuitJson()).find(
      (element) =>
        element.type === "source_component" &&
        element.ftype === "simple_resistor",
    )
    expect(
      resistor && "resistance" in resistor ? resistor.resistance : undefined,
    ).toBe(4700)
    await runner.kill()
  })

  test("erases type-only imports without reading their packages or files", async () => {
    const directory = await createProject({
      "index.tsx": `import type { ChipProps } from '@tscircuit/props'
import { type Missing } from './missing-types'
export type { Other } from 'uninstalled-types'
// import 'https://example.com/comment'
export default (props: ChipProps) => <chip name="U1" {...props} />`,
    })
    const { fsMap } = await readCircuitProject(
      path.join(directory, "index.tsx"),
    )
    expect(Object.keys(fsMap)).toHaveLength(1)
    const source = fsMap["module-0000.tsx"]!
    expect(source).not.toContain("@tscircuit/props")
    expect(source).not.toContain("missing-types")
    expect(source).not.toContain("uninstalled-types")
    expect(source).toContain("props: ChipProps")
  })

  test("accepts embedded package modules and preserves runtime mixed imports", async () => {
    const directory = await createProject({
      "index.tsx": `import { type ReactNode, Fragment } from 'react'; import { RootCircuit } from '@tscircuit/core'; import 'react/jsx-runtime'; export default () => <Fragment />`,
    })
    const { fsMap } = await readCircuitProject(
      path.join(directory, "index.tsx"),
    )
    expect(fsMap["module-0000.tsx"]).toContain('"react"')
    expect(fsMap["module-0000.tsx"]).toContain('"@tscircuit/core"')
  })

  for (const source of [
    `const load = () => import('./child')`,
    `const load = () => import('react')`,
    "const load = () => import(`./child`)",
  ]) {
    test(`rejects literal dynamic imports: ${source}`, async () => {
      const directory = await createProject({
        "index.tsx": `${source}; export default () => <board />`,
        "child.ts": `export const value = 123`,
      })
      await expect(
        readCircuitProject(path.join(directory, "index.tsx")),
      ).rejects.toThrow("Dynamic imports are not supported")
    })
  }

  test("rejects top-level await while allowing await within async functions", async () => {
    for (const source of [
      `const value = await Promise.resolve(123); export default () => <board />`,
      `for await (const value of []) {} export default () => <board />`,
    ]) {
      const directory = await createProject({ "index.tsx": source })
      await expect(
        readCircuitProject(path.join(directory, "index.tsx")),
      ).rejects.toThrow("Top-level await is not supported")
    }
    const directory = await createProject({
      "index.tsx": `async function load() { await Promise.resolve(123) }; export default () => <board />`,
    })
    const { fsMap } = await readCircuitProject(
      path.join(directory, "index.tsx"),
    )
    expect(Object.keys(fsMap)).toHaveLength(1)
  })

  for (const specifier of [
    "uninstalled-package",
    "react/jsx-dev-runtime",
    "@tscircuit/core/unsupported-subpath",
    "@tsci/author.remote-part",
    "https://example.com/circuit.tsx",
    "node:fs",
    "/absolute/source.tsx",
  ]) {
    test(`rejects unbundled runtime import ${specifier}`, async () => {
      const directory = await createProject({
        "index.tsx": `import ${JSON.stringify(specifier)}; export default () => <board />`,
      })
      await expect(
        readCircuitProject(path.join(directory, "index.tsx")),
      ).rejects.toThrow("is not bundled")
    })
  }

  for (const source of [
    `const name = './child'; const load = () => import(name)`,
    "const load = () => import(`./${name}`)",
    `const load = () => require('./child')`,
    `const load = () => (require)('./child')`,
    `import child = require('./child')`,
  ]) {
    test(`rejects imports whose runtime resolution is unsupported: ${source}`, async () => {
      const directory = await createProject({ "index.ts": source })
      await expect(
        readCircuitProject(path.join(directory, "index.ts")),
      ).rejects.toThrow("not supported")
    })
  }

  test("reports missing imports with their relative source filename", async () => {
    const directory = await createProject({
      "index.tsx": `import './missing'; export default () => <board />`,
    })
    await expect(
      readCircuitProject(path.join(directory, "index.tsx")),
    ).rejects.toThrow('Import "./missing" in index.tsx was not found')
  })

  test("rejects lexical escapes, node_modules, project configuration and assets", async () => {
    for (const [specifier, message] of [
      ["../outside.tsx", "escapes"],
      ["./node_modules/local/index.tsx", "node_modules"],
      ["./tscircuit.config.ts", "configuration imports"],
      ["./tsconfig.json", "configuration imports"],
      ["./model.glb", "only TS"],
    ]) {
      const directory = await createProject({
        "index.tsx": `import ${JSON.stringify(specifier)}; export default () => <board />`,
        "node_modules/local/index.tsx": `export default () => <board />`,
        "tscircuit.config.ts": `export default { useCloudAutorouter: true }`,
        "tsconfig.json": `{}`,
        "model.glb": `unsupported binary asset`,
      })
      await expect(
        readCircuitProject(path.join(directory, "index.tsx")),
      ).rejects.toThrow(message!)
    }
  })

  test("rejects source symlinks that leave the project directory", async () => {
    const directory = await createProject({
      "index.tsx": `import './external'; export default () => <board />`,
    })
    const outside = await createProject({
      "external.tsx": `export default () => <board />`,
    })
    await symlink(
      path.join(outside, "external.tsx"),
      path.join(directory, "external.tsx"),
    )
    await expect(
      readCircuitProject(path.join(directory, "index.tsx")),
    ).rejects.toThrow("symlink outside")
  })

  test("accepts an entry whose parent directory is a symlink alias", async () => {
    const directory = await createProject({
      "project/index.tsx": `import { Child } from './child'; export default () => <Child />`,
      "project/child.tsx": `export const Child = () => <board />`,
    })
    const aliasPath = path.join(directory, "project-alias")
    await symlink(path.join(directory, "project"), aliasPath, "dir")
    const { fsMap, mainComponentPath } = await readCircuitProject(
      path.join(aliasPath, "index.tsx"),
    )
    expect(mainComponentPath).toBe("module-0000.tsx")
    expect(Object.keys(fsMap)).toHaveLength(2)
    expect(fsMap[mainComponentPath]).toContain('"./module-0001.tsx"')
  })

  test("rejects an entry-file symlink outside its canonical parent directory", async () => {
    const directory = await createProject({})
    const outside = await createProject({
      "external.tsx": `export default () => <board />`,
    })
    await symlink(
      path.join(outside, "external.tsx"),
      path.join(directory, "index.tsx"),
    )
    await expect(
      readCircuitProject(path.join(directory, "index.tsx")),
    ).rejects.toThrow("symlink outside")
  })

  test("rejects projects over the file or source size limits", async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index <= 100; index++) {
      files[`file${index}.ts`] =
        index < 100 ? `import './file${index + 1}'` : "export const value = 1"
    }
    const tooManyFiles = await createProject(files)
    await expect(
      readCircuitProject(path.join(tooManyFiles, "file0.ts")),
    ).rejects.toThrow("100 source file limit")
    const tooManyBytes = await createProject({
      "index.ts": `import './other';\n//${"x".repeat(1024 * 1024)}`,
      "other.ts": `//${"x".repeat(1024 * 1024)}`,
    })
    await expect(
      readCircuitProject(path.join(tooManyBytes, "index.ts")),
    ).rejects.toThrow("2 MiB source size limit")
  })

  test("reports invalid source and JSON locally", async () => {
    const invalidSource = await createProject({
      "index.tsx": `export default () => <board`,
    })
    await expect(
      readCircuitProject(path.join(invalidSource, "index.tsx")),
    ).rejects.toThrow("Cannot parse circuit source")
    const invalidJson = await createProject({
      "index.ts": `import './values.json'`,
      "values.json": "{",
    })
    await expect(
      readCircuitProject(path.join(invalidJson, "index.ts")),
    ).rejects.toThrow("Invalid JSON")
  })
})
