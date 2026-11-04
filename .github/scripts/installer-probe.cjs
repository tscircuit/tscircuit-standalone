const fs = require("node:fs")
const path = require("node:path")
const { spawn } = require("node:child_process")
const directory = path.join(process.env.RUNNER_TEMP, "installer-node-probe")
fs.mkdirSync(directory, { recursive: true })
const stdout = fs.openSync(path.join(directory, "stdout.txt"), "w")
const stderr = fs.openSync(path.join(directory, "stderr.txt"), "w")
fs.writeFileSync(path.join(directory, "launch.json"), JSON.stringify({ started: new Date().toISOString() }))
const child = spawn("pwsh.exe", [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
  path.resolve("scripts/windows-installer/smoke.ps1"),
  "-Installer", path.resolve("installer/installer.exe"),
  "-Binary", path.resolve("dist/tsci.exe"),
  "-Version", "0.0.3075", "-DiagnosticsDirectory", directory,
], { detached: true, windowsHide: true, stdio: ["ignore", stdout, stderr] })
if (child.pid) fs.appendFileSync(process.env.GITHUB_ENV, "INSTALLER_PROBE_PID=" + child.pid + "\n")
let finished = false
function finish(exited, exitCode, error) {
  if (finished) return
  finished = true
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({
    exited, exitCode, error, pid: child.pid, observedAt: new Date().toISOString(),
  }, null, 2))
  child.unref()
  fs.closeSync(stdout)
  fs.closeSync(stderr)
  console.log(exited ? "Installer verification exited: " + exitCode : "Diagnostic deadline reached; saving partial logs")
  process.exit(0)
}
child.on("error", error => finish(true, null, error.message))
child.on("exit", (code, signal) => finish(true, code, signal))
setTimeout(() => finish(false, null), 180000)
