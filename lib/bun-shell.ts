import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

/** Child shells must route bun too; interactive shell functions are not inherited. */
export async function writeBunLauncher(directory: string, command: string[]): Promise<string> {
  await mkdir(directory, { recursive: true })
  const quote = (arg: string) => process.platform === "win32" ? `"${arg}"` : `'${arg.replaceAll("'", "'\\''")}'`
  await writeFile(join(directory, process.platform === "win32" ? "bun.cmd" : "bun"),
    process.platform === "win32"
      ? `@echo off\r\nset "BUN_BE_BUN="\r\n${command.map(quote).join(" ")} %*\r\nexit /b %errorlevel%\r\n`
      : `#!/bin/sh\nunset BUN_BE_BUN\nexec ${command.map(quote).join(" ")} "$@"\n`, { mode: 0o755 })
  return directory
}

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
