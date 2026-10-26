import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareRelease } from "../scripts/prepare-release"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

const npmMetadata = {
  name: "tscircuit",
  version: "0.0.2839",
  dependencies: {
    "@tscircuit/core": "^0.0.2132",
    "@tscircuit/eval": "~0.0.1596",
    "@tscircuit/props": "0.0.700",
    "@tscircuit/checks": "^0.0.247",
    "@tscircuit/circuit-json-util": "^0.0.121",
  },
}

const fixture = async () => {
  const projectRoot = await mkdtemp(
    join(tmpdir(), "standalone-release-inputs-"),
  )
  directories.push(projectRoot)
  await mkdir(join(projectRoot, "ui"))
  const root = {
    name: "@tscircuit/standalone",
    version: "0.0.0-alpha.1",
    scripts: { check: "bun test" },
    workspaces: ["ui"],
    dependencies: {
      "@tscircuit/core": "0.0.2116",
      tscircuit: "npm:@tscircuit/core@0.0.2116",
      "@tscircuit/eval": "0.0.1569",
      "@tscircuit/props": "0.0.697",
      "@tscircuit/footprinter": "0.0.437",
      react: "19.2.7",
    },
    devDependencies: { typescript: "5.9.3" },
    overrides: { altiumts: "0.0.59", "@tscircuit/core": "0.0.2116" },
    trustedDependencies: [],
  }
  const ui = {
    name: "@tscircuit/standalone-ui",
    private: true,
    dependencies: {
      "@tscircuit/eval": "0.0.1569",
      "@tscircuit/runframe": "0.0.2953",
      "@tscircuit/internal-dynamic-import": "0.0.17",
      react: "19.1.0",
      "schematic-analysis": "https://jscdn.tscircuit.com/analysis/0.0.46.tgz",
    },
  }
  const files = {
    "package.json": `${JSON.stringify(root, null, 2)}\n`,
    "ui/package.json": `${JSON.stringify(ui, null, 2)}\n`,
    "bun.lock": "fixture lock must not change when installation is disabled\n",
  }
  for (const [path, content] of Object.entries(files))
    await writeFile(join(projectRoot, path), content)
  const assertUnchanged = async () => {
    for (const [path, content] of Object.entries(files))
      expect(await readFile(join(projectRoot, path), "utf8")).toBe(content)
  }
  return { projectRoot, root, ui, files, assertUnchanged }
}

test("preparation selects the npm version and aligns every core/eval graph while preserving unrelated pins", async () => {
  const { projectRoot, root, ui } = await fixture()
  let installed = false
  const release = await prepareRelease({
    projectRoot,
    fetch: async (url) => {
      expect(url).toBe("https://registry.npmjs.org/tscircuit/latest")
      return Response.json(npmMetadata)
    },
    install: async (installedRoot) => {
      expect(installedRoot).toBe(projectRoot)
      expect(await Bun.file(join(projectRoot, "bun.lock")).exists()).toBe(false)
      expect(
        (await Bun.file(join(projectRoot, "package.json")).json()).version,
      ).toBe(npmMetadata.version)
      installed = true
    },
  })
  expect(installed).toBe(true)
  expect(release).toEqual({
    version: "0.0.2839",
    coreVersion: "0.0.2132",
    evalVersion: "0.0.1596",
    propsVersion: "0.0.700",
  })
  expect(await Bun.file(join(projectRoot, "package.json")).json()).toEqual({
    ...root,
    version: npmMetadata.version,
    dependencies: {
      ...root.dependencies,
      "@tscircuit/core": "0.0.2132",
      tscircuit: "npm:@tscircuit/core@0.0.2132",
      "@tscircuit/eval": "0.0.1596",
      "@tscircuit/props": "0.0.700",
      "@tscircuit/checks": "0.0.247",
      "@tscircuit/circuit-json-util": "0.0.121",
    },
    overrides: {
      ...root.overrides,
      "@tscircuit/core": "0.0.2132",
      "@tscircuit/eval": "0.0.1596",
      "@tscircuit/props": "0.0.700",
      "@tscircuit/checks": "0.0.247",
      "@tscircuit/circuit-json-util": "0.0.121",
    },
  })
  expect(await Bun.file(join(projectRoot, "ui/package.json")).json()).toEqual({
    ...ui,
    dependencies: { ...ui.dependencies, "@tscircuit/eval": "0.0.1596" },
  })
})

test("an exact requested npm version is used and must match the response", async () => {
  const fixtureData = await fixture()
  await expect(
    prepareRelease({
      projectRoot: fixtureData.projectRoot,
      version: "0.0.2838",
      fetch: async (url) => {
        expect(url).toBe("https://registry.npmjs.org/tscircuit/0.0.2838")
        return Response.json(npmMetadata)
      },
      install: false,
    }),
  ).rejects.toThrow("Requested tscircuit 0.0.2838, received 0.0.2839")
  await fixtureData.assertUnchanged()
  await prepareRelease({
    projectRoot: fixtureData.projectRoot,
    version: npmMetadata.version,
    fetch: async () => Response.json(npmMetadata),
    install: false,
  })
  expect(
    await readFile(join(fixtureData.projectRoot, "bun.lock"), "utf8"),
  ).toBe(fixtureData.files["bun.lock"])
})

test("release preparation installs core runtime helpers from the selected npm release", async () => {
  const { projectRoot, root, ui } = await fixture()
  await prepareRelease({
    projectRoot,
    fetch: async () => Response.json(npmMetadata),
    install: false,
  })
  const runtimeDependencies = {
    "@tscircuit/infer-cable-insertion-point": "0.0.4",
    "@tscircuit/copper-pour-solver": "0.0.67",
    "@tscircuit/miniflex": "0.0.4",
    minicssgrid: "0.0.9",
    spicey: "0.0.14",
  }
  await prepareRelease({
    projectRoot,
    fetch: async () =>
      Response.json({
        ...npmMetadata,
        dependencies: {
          ...npmMetadata.dependencies,
          ...Object.fromEntries(
            Object.entries(runtimeDependencies).map(([name, version]) => [
              name,
              `^${version}`,
            ]),
          ),
        },
      }),
    install: async () => {
      expect(await Bun.file(join(projectRoot, "bun.lock")).exists()).toBe(false)
      const prepared = await Bun.file(join(projectRoot, "package.json")).json()
      expect(prepared.dependencies).toMatchObject(runtimeDependencies)
      expect(prepared.overrides).toMatchObject(runtimeDependencies)
      expect(prepared.dependencies["@tscircuit/footprinter"]).toBe(
        root.dependencies["@tscircuit/footprinter"],
      )
      expect(await Bun.file(join(projectRoot, "ui/package.json")).json())
        .toMatchObject({ dependencies: { react: ui.dependencies.react } })
    },
  })
})

test("invalid runtime helper versions fail before changing release inputs", async () => {
  const { projectRoot, assertUnchanged } = await fixture()
  await expect(
    prepareRelease({
      projectRoot,
      fetch: async () =>
        Response.json({
          ...npmMetadata,
          dependencies: { ...npmMetadata.dependencies, spicey: "latest" },
        }),
      install: false,
    }),
  ).rejects.toThrow("Unsupported tscircuit dependency range for spicey")
  await assertUnchanged()
})

test("invalid npm metadata and missing or unsupported dependency ranges fail before changing manifests", async () => {
  for (const metadata of [
    null,
    [],
    { ...npmMetadata, name: "@tscircuit/core" },
    { ...npmMetadata, version: "0.0.02839" },
    { ...npmMetadata, version: "0.0.2839-daily.01" },
    { ...npmMetadata, version: "0.0.2839-daily..1" },
    { ...npmMetadata, version: "latest" },
    { ...npmMetadata, dependencies: undefined },
    { ...npmMetadata, dependencies: [] },
    ...[
      "@tscircuit/core",
      "@tscircuit/eval",
      "@tscircuit/props",
      "@tscircuit/checks",
      "@tscircuit/circuit-json-util",
    ].map((name) => ({
      ...npmMetadata,
      dependencies: { ...npmMetadata.dependencies, [name]: undefined },
    })),
    {
      ...npmMetadata,
      dependencies: {
        ...npmMetadata.dependencies,
        "@tscircuit/core": "latest",
      },
    },
    {
      ...npmMetadata,
      dependencies: {
        ...npmMetadata.dependencies,
        "@tscircuit/core": ">=0.0.2132",
      },
    },
  ]) {
    const { projectRoot, assertUnchanged } = await fixture()
    await expect(
      prepareRelease({
        projectRoot,
        fetch: async () => Response.json(metadata),
        install: false,
      }),
    ).rejects.toThrow()
    await assertUnchanged()
  }
})

test("registry HTTP failures do not write release inputs", async () => {
  for (const status of [404, 503]) {
    const { projectRoot, assertUnchanged } = await fixture()
    await expect(
      prepareRelease({
        projectRoot,
        fetch: async () => new Response("registry failure", { status }),
        install: false,
      }),
    ).rejects.toThrow(`HTTP ${status}`)
    await assertUnchanged()
  }
})

test("non-exact version arguments are rejected before fetching", async () => {
  for (const version of [
    "^0.0.2839",
    "latest\n",
    "0.0.2839/../latest",
    "v0.0.2839",
  ]) {
    const { projectRoot, assertUnchanged } = await fixture()
    await expect(
      prepareRelease({
        projectRoot,
        version,
        fetch: async () => {
          throw new Error("must not fetch")
        },
        install: false,
      }),
    ).rejects.toThrow("Expected an exact tscircuit version or latest")
    await assertUnchanged()
  }
})

test("installation failure prevents a successful release preparation", async () => {
  const { projectRoot } = await fixture()
  await expect(
    prepareRelease({
      projectRoot,
      fetch: async () => Response.json(npmMetadata),
      install: async () => {
        throw new Error("fixture install failed")
      },
    }),
  ).rejects.toThrow("fixture install failed")
})

test("preparing the same dependency versions keeps the existing lockfile", async () => {
  const { projectRoot, files } = await fixture()
  await prepareRelease({
    projectRoot,
    fetch: async () => Response.json(npmMetadata),
    install: false,
  })
  await prepareRelease({
    projectRoot,
    fetch: async () => Response.json(npmMetadata),
    install: async () => {
      expect(await readFile(join(projectRoot, "bun.lock"), "utf8")).toBe(
        files["bun.lock"],
      )
    },
  })
})
