import { delimiter, dirname, join } from "node:path"
import { nativeCacheDirectory } from "./native-bun"
import { restoreEmbeddedDirectory, safeRelative, type EmbeddedDirectory } from "./embedded-directory"

export interface PackagedRuntime extends EmbeddedDirectory {
  entrypoint: string
}

/** Restore published files, including manifests, workers and native assets. */
export async function restorePackagedRuntime(bundle: PackagedRuntime) {
  const root = join(dirname(nativeCacheDirectory(bundle)), "runtime-" + bundle.bunVersion + "-" + bundle.id)
  await restoreEmbeddedDirectory(bundle, root)
  return { entrypoint: join(root, safeRelative(bundle.entrypoint)), nodeModules: join(root, "node_modules") }
}

/** Use Bun mode so package resolution follows the installed filesystem graph. */
export async function runPackagedCli(runtime: { entrypoint: string; nodeModules: string }, args = process.argv.slice(2)) {
  const runtimeArgs = JSON.parse(process.env.TSCIRCUIT_NODE_RUNTIME_ARGS ?? "[]") as string[]
  const child = Bun.spawn([process.execPath, ...runtimeArgs, runtime.entrypoint, ...args], {
    env: {
      ...process.env,
      BUN_BE_BUN: "1",
      BUN_INSTALL_AUTO: "disable",
      NODE_PATH: [process.env.NODE_PATH, runtime.nodeModules].filter(Boolean).join(delimiter),
    },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  })
  let interrupted: number | undefined
  const signals = { SIGINT: 130, SIGTERM: 143 } as const
  const handlers = Object.entries(signals).map(([signal, code]) => {
    const handler = () => {
      interrupted = code
      if (child.exitCode === null) child.kill(signal as NodeJS.Signals)
    }
    process.once(signal, handler)
    return { signal, handler }
  })
  try {
    const code = await child.exited
    return interrupted ?? code
  } finally {
    for (const { signal, handler } of handlers) process.removeListener(signal, handler)
  }
}
