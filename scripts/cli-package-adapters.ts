import { readFile, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { findUiPackageRoot } from "./ui-package-adapters"
import { adaptStandaloneInit, adaptStandaloneSkillSetup } from "./standalone-init-adapters"

/** Include build-time dependencies that normally resolve files from node_modules. */
export const cliPackageAdapters: Bun.BunPlugin = {
  name: "standalone-cli-packages",
  setup(build) {
    build.onLoad({ filter: /cli\/init\/register\.ts$/ }, async ({ path }) => ({
      contents: adaptStandaloneInit(await readFile(path, "utf8")),
      loader: "ts",
    }))
    build.onLoad({ filter: /lib\/shared\/setup-tscircuit-skill\.ts$/ }, async ({ path }) => ({
      contents: adaptStandaloneSkillSetup(await readFile(path, "utf8")),
      loader: "ts",
    }))
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
    // Embed the CLI's eval worker using RunFrame's existing browser build hook.
    build.onLoad(
      { filter: /runframe\/dist\/standalone\.min\.js$/ },
      async ({ path }) => {
        const source = await readFile(path, "utf8")
        const placeholder = '"<--INJECT_TSCIRCUIT_EVAL_WEB_WORKER_BLOB_URL-->"'
        if (!source.includes(placeholder)) {
          throw new Error("RunFrame eval worker placeholder is missing")
        }
        const workerPath = Bun.resolveSync(
          "@tscircuit/eval/worker-entrypoint",
          resolve("node_modules/@tscircuit/cli"),
        )
        const worker = (await readFile(workerPath)).toString("base64")
        return {
          contents: source.replaceAll(
            placeholder,
            `URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(worker)}), c => c.charCodeAt(0))], { type: "application/javascript" }))`,
          ),
          loader: "text",
        }
      },
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
