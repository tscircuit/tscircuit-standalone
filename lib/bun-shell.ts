import { readFile, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"

export function bunWorkingDirectory(args: string[]): string {
  let directory = process.cwd()
  for (let i = 0; i < args.length && args[i] !== "--"; i++) {
    if (args[i] === "--cwd" && args[i + 1]) directory = resolve(directory, args[++i]!)
    else if (args[i]!.startsWith("--cwd=")) directory = resolve(directory, args[i]!.slice(6))
  }
  return directory
}

export async function bunProjectDirectory(args: string[]): Promise<string> {
  const original = bunWorkingDirectory(args)
  let directory = original
  for (;;) {
    if ((await stat(resolve(directory, "package.json")).catch(() => undefined))?.isFile()) return directory
    const parent = dirname(directory)
    if (parent === directory) return original
    directory = parent
  }
}

export async function isTscircuitProject(args: string[]): Promise<boolean> {
  let directory = bunWorkingDirectory(args)
  for (;;) {
    if ((await stat(resolve(directory, "tscircuit.config.json")).catch(() => undefined))?.isFile()) return true
    const pkg = await readFile(resolve(directory, "package.json"), "utf8").then(JSON.parse).catch(() => undefined)
    if (pkg && [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies].some(deps => deps && Object.hasOwn(deps, "tscircuit"))) return true
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

export function bunShellIntegration(shell: string, binary: string | string[]): string {
  const command = typeof binary === "string" ? [binary] : binary
  if (shell === "bash" || shell === "zsh" || shell === "sh") {
    const executable = command.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")
    return `bun() {
  if (unset BUN_BE_BUN; command ${executable} internal is-project "$@"); then
    (unset BUN_BE_BUN; command ${executable} internal bun "$@")
  else
    command bun "$@"
  fi
}
`
  }
  if (shell === "powershell" || shell === "pwsh") {
    const executable = command.map(arg => `'${arg.replaceAll("'", "''")}'`).join(" ")
    return `function global:bun {
  $savedBunMode = $env:BUN_BE_BUN
  try {
    $env:BUN_BE_BUN = $null
    & ${executable} internal is-project @args
    if ($LASTEXITCODE -eq 0) { & ${executable} internal bun @args }
    else { & (Get-Command bun -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source @args }
  } finally { $env:BUN_BE_BUN = $savedBunMode }
}
`
  }
  throw new Error("Supported Bun shell wrappers: bash, zsh, powershell")
}
