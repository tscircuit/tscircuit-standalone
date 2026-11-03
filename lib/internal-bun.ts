import { fileURLToPath } from "node:url"

declare const TSCIRCUIT_STANDALONE_COMPILED: boolean

export function getInternalBunArguments(args: string[]): string[] {
  const compiled =
    typeof TSCIRCUIT_STANDALONE_COMPILED !== "undefined" &&
    TSCIRCUIT_STANDALONE_COMPILED
  return [
    process.execPath,
    ...(compiled
      ? []
      : [fileURLToPath(new URL("../cli/standalone.ts", import.meta.url))]),
    "internal",
    "bun",
    ...args,
  ]
}

export function getInternalBunCommandPrefix(): string {
  return (
    process.env.TSCIRCUIT_NODE_RUNTIME ||
    getInternalBunArguments([])
      .map((argument) =>
        process.platform === "win32"
          ? `"${argument}"`
          : `'${argument.replaceAll("'", "'\\''")}'`,
      )
      .join(" ")
  )
}

/** Only this child enters Bun CLI mode; the standalone parent remains an app. */
export async function runInternalBun(args: string[]): Promise<number> {
  const child = Bun.spawn([process.execPath, ...args], {
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const interrupt = () => child.kill("SIGINT")
  const terminate = () => child.kill("SIGTERM")
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  try {
    return await child.exited
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
  }
}
