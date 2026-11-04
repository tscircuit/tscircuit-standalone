const fs = require("node:fs")
const path = require("node:path")
const { spawn } = require("node:child_process")
const directory = path.join(process.env.RUNNER_TEMP, "installer-node-probe")
fs.mkdirSync(directory, { recursive: true })
const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const quote = value => "'" + value.replaceAll("'", "''") + "'"
const command = "Write-Output 'INSTALLER_PROBE_STARTED'; & " +
  quote(path.resolve("scripts/windows-installer/smoke.ps1")) +
  " -Installer " + quote(path.resolve("installer/installer.exe")) +
  " -Binary " + quote(path.resolve("dist/tsci.exe")) +
  " -Version '0.0.3075' -DiagnosticsDirectory " + quote(directory)
const stdout = fs.openSync(path.join(directory, "stdout.txt"), "w")
const stderr = fs.openSync(path.join(directory, "stderr.txt"), "w")
fs.writeFileSync(path.join(directory, "launch.json"), JSON.stringify({ powershell, command, started: new Date().toISOString() }, null, 2))
const read = name => {
  try {
    const data = fs.readFileSync(path.join(directory, name))
    return data[0] === 255 && data[1] === 254 ? data.toString("utf16le") : data.toString("utf8")
  } catch { return "" }
}
let child
let finished = false
function finish(exited, exitCode, error) {
  if (finished) return
  finished = true
  const transcript = read("smoke.txt")
  const verified = exited && exitCode === 0 && transcript.includes("Windows installer install/conflict/upgrade/uninstall/rollback checks passed")
  fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({
    exited, exitCode, verified, error, pid: child?.pid, observedAt: new Date().toISOString(),
  }, null, 2))
  for (const name of ["stdout.txt", "stderr.txt", "smoke.txt"]) {
    fs.writeSync(1, "\n--- " + name + " ---\n" + read(name).slice(-20000))
  }
  const done = () => {
    child?.unref()
    fs.closeSync(stdout)
    fs.closeSync(stderr)
    fs.writeSync(1, "\n" + JSON.stringify({ exited, exitCode, verified, error }) + "\n")
    process.exit(0)
  }
  if (!exited && child?.pid) {
    const kill = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true, stdio: "ignore",
    })
    kill.once("exit", done)
    kill.once("error", done)
    setTimeout(done, 10000)
  } else done()
}
setTimeout(() => finish(false, null, "diagnostic deadline"), 180000)
child = spawn(powershell, [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command,
], { windowsHide: true, stdio: ["ignore", stdout, stderr] })
child.on("error", error => finish(true, null, error.message))
child.on("exit", (code, signal) => finish(true, code, signal))
