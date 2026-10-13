import { readFile, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { findUiPackageRoot } from "./ui-package-adapters"

/** Include build-time dependencies that normally resolve files from node_modules. */
export const cliPackageAdapters: Bun.BunPlugin = {
  name: "standalone-cli-packages",
  setup(build) {
    // The pinned GitHub dependency includes CLI source, before its npm build.
    const cliEntries: Record<string, string> = {
      "@tscircuit/cli": "main.ts",
      "@tscircuit/cli/build.worker": "build/build.worker.ts",
      "@tscircuit/cli/snapshot.worker": "snapshot/snapshot.worker.ts",
    }
    build.onResolve(
      { filter: /^@tscircuit\/cli(?:\/(?:build|snapshot)\.worker)?$/ },
      async ({ path }) => ({
        path: await realpath(
          resolve("node_modules/@tscircuit/cli/cli", cliEntries[path]!),
        ),
      }),
    )
    // Use the existing portable renderer instead of a host-specific native addon.
    build.onResolve({ filter: /^@resvg\/resvg-(?:js|wasm)$/ }, async () => ({
      path: join(await findUiPackageRoot("@resvg/resvg-wasm"), "index.js"),
    }))
    build.onResolve({ filter: /^rollup(?:\/|$)/ }, ({ path }) => ({
      path: fileURLToPath(
        import.meta.resolve(path.replace(/^rollup/, "@rollup/wasm-node")),
      ),
    }))
    build.onLoad({ filter: /rollup-plugin-dts.*\.mjs$/ }, async ({ path }) => ({
      contents: (await readFile(path, "utf8")).replace(
        'require$1("typescript")',
        'require("typescript")',
      ),
      loader: "js",
    }))
    build.onLoad(
      { filter: /wasm-node\/bindings_wasm\.js$/ },
      async ({ path }) => ({
        contents: (await readFile(path, "utf8")).replace(
          "const wasmPath = `${__dirname}/bindings_wasm_bg.wasm`;",
          'import wasmPath from "./bindings_wasm_bg.wasm" with { type: "file" };',
        ),
        loader: "js",
      }),
    )
  },
}
