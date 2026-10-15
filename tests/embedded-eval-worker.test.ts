import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { cliPackageAdapters } from "../scripts/cli-package-adapters"

test("the CLI's RunFrame text import contains its complete eval worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "embedded-eval-"))
  try {
    const bundlePath = join(directory, "runframe/dist/standalone.min.js")
    await mkdir(join(directory, "runframe/dist"), { recursive: true })
    await writeFile(
      bundlePath,
      'globalThis.workerUrl = "<--INJECT_TSCIRCUIT_EVAL_WEB_WORKER_BLOB_URL-->"',
    )
    const entry = join(directory, "entry.ts")
    await writeFile(
      entry,
      `import bundle from ${JSON.stringify(bundlePath)} with { type: "text" }; export default bundle`,
    )
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: join(directory, "output"),
      target: "bun",
      plugins: [cliPackageAdapters],
    })
    expect(result.success).toBe(true)
    const { default: bundle } = await import(result.outputs[0]!.path)
    let worker: Blob | undefined
    const browser = {
      Blob,
      Uint8Array,
      atob,
      URL: {
        createObjectURL: (blob: Blob) => {
          worker = blob
          return "blob:embedded-eval"
        },
      },
      workerUrl: undefined as string | undefined,
    }
    runInNewContext(bundle, browser)
    expect(browser.workerUrl).toBe("blob:embedded-eval")
    const workerPath = Bun.resolveSync(
      "@tscircuit/eval/worker-entrypoint",
      resolve("node_modules/@tscircuit/cli"),
    )
    expect(
      Buffer.from(await worker!.arrayBuffer()).equals(
        await readFile(workerPath),
      ),
    ).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
