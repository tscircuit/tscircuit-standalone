const fs = require("node:fs")
const path = require("node:path")
const { spawn, spawnSync } = require("node:child_process")
const directory = path.join(process.env.RUNNER_TEMP, "installer-node-probe")
fs.mkdirSync(directory, { recursive: true })
const powershell = path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe")
const sanity = spawnSync(powershell, [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
  "-Command", "Write-Output 'POWERSHELL_PROBE_READY'; exit 17",
], { encoding: "utf8", timeout: 10000, windowsHide: true })
const sanityResult = { executable: powershell, status: sanity.status, stdout: sanity.stdout, stderr: sanity.stderr, error: sanity.error?.message }
fs.writeFileSync(path.join(directory, "sanity.json"), JSON.stringify(sanityResult, null, 2))
console.log(JSON.stringify(sanityResult))
if (sanity.status !== 17 || !sanity.stdout.includes("POWERSHELL_PROBE_READY")) {
  throw new Error("PowerShell child launch did not execute the sanity command")
}
const quote = value => "'" + value.replaceAll("'", "''") + "'"
const command = "Write-Output 'INSTALLER_PROBE_STARTED'; & " +
  quote(path.resolve("scripts/windows-installer/smoke.ps1")) +
  " -Installer " + quote(path.resolve("installer/installer.exe")) +
  " -Binary " + quote(path.resolve("dist/tsci.exe")) +
  " -Version '0.0.3075' -DiagnosticsDirectory " + quote(directory)
const stdout = fs.openSync(path.join(directory, "stdout.txt"), "w")
const stderr = fs.openSync(path.join(directory, "stderr.txt"), "w")
fs.writeFileSync(path.join(directory, "launch.json"), JSON.stringify({ powershell, command, started: new Date().toISOString() }, null, 2))
const child = spawn(powershell, [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command,
], { windowsHide: true, stdio: ["ignore", stdout, stderr] })
const read = name => {
  try { return fs.readFileSync(path.join(directory, name), "utf8") } catch { return "" }
}
let finished = false
function finish(exited, exitCode, error) {
  if (finished) return
  finished = true
  const transcript = read("smoke.txt")
  const verified = exited && exitCode === 0 && transcript.includes("Windows installer install/conflict/upgrade/uninstall/rollback checks passed")
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({
    exited, exitCode, verified, error, pid: child.pid, observedAt: new Date().toISOString(),
  }, null, 2))
  for (const name of ["stdout.txt", "stderr.txt", "smoke.txt"]) {
    fs.writeSync(1, "\n--- " + name + " ---\n" + read(name).slice(-20000))
  }
  if (!exited && child.pid) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      timeout: 10000, windowsHide: true, stdio: "ignore",
    })
    try { child.kill("SIGKILL") } catch {}
  }
  child.unref()
  fs.closeSync(stdout)
  fs.closeSync(stderr)
  fs.writeSync(1, "\n" + JSON.stringify({ exited, exitCode, verified, error }) + "\n")
  process.exit(0)
}
child.on("error", error => finish(true, null, error.message))
child.on("exit", (code, signal) => finish(true, code, signal))
setTimeout(() => finish(false, null), 180000)
