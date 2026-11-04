const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const assert = require("node:assert/strict")
const { spawn, spawnSync } = require("node:child_process")
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "installer-module-probe-"))
const shims = path.join(directory, "existing commands")
fs.mkdirSync(shims)
for (const name of ["tsci", "tscircuit"])
  fs.writeFileSync(path.join(shims, name + ".cmd"), "@echo existing command\r\n")
const reg = path.join(process.env.SystemRoot, "System32", "reg.exe")
function registry(args) {
  const result = spawnSync(reg, args, { encoding: "utf8", windowsHide: true, timeout: 10000 })
  if (result.error) throw result.error
  return result
}
const query = registry(["query", "HKCU\\Environment", "/v", "Path"])
const match = query.stdout.match(/^\s*Path\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/im)
if (query.status !== 0 && query.status !== 1) throw new Error(query.stderr)
const old = match ? { type: match[1], value: match[2].trimEnd() } : null
const staged = shims + ";" + (old?.value ?? "")
assert.equal(registry(["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", staged, "/f"]).status, 0)
const coreModules = path.join(process.env.ProgramFiles, "PowerShell", "7", "Modules")
assert.ok(fs.existsSync(coreModules), "PowerShell 7 module path is missing")
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"))
env.PSModulePath = coreModules
const decode = file => {
  if (!fs.existsSync(file)) return ""
  const bytes = fs.readFileSync(file)
  return bytes[0] === 255 && bytes[1] === 254 ? bytes.toString("utf16le") : bytes.toString("utf8")
}
async function run(name) {
  const log = path.join(directory, name + ".log")
  const target = path.join(directory, name + " app")
  const child = spawn(path.resolve("module-probes", name, "installer.exe"), [
    "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/DIR=" + target, "/LOG=" + log,
  ], { env, windowsHide: true, stdio: "ignore" })
  let timedOut = false
  const code = await new Promise(resolve => {
    let settled = false
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const timer = setTimeout(() => {
      timedOut = true
      const kill = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      kill.once("exit", () => finish(null))
      kill.once("error", () => finish(null))
      setTimeout(() => finish(null), 5000)
    }, 20000)
    child.once("exit", finish)
    child.once("error", error => { console.error(error.message); finish(null) })
  })
  const text = decode(log)
  const consent = text.includes("Existing tscircuit commands were found.")
  const copied = fs.existsSync(path.join(target, "tsci.exe"))
  const result = { name, code, timedOut, consent, copied }
  console.log(JSON.stringify(result))
  console.log(text.slice(-12000))
  return result
}
;(async () => {
  try {
    const baseline = await run("baseline")
    const fixed = await run("fixed")
    assert.equal(baseline.consent, false, "Baseline unexpectedly reached the consent check")
    assert.equal(fixed.timedOut, false, "Fixed installer helper did not complete")
    assert.equal(fixed.consent, true, "Fixed installer did not reach the consent check")
    assert.equal(fixed.copied, false, "Probe copied a payload without takeover consent")
    assert.notEqual(fixed.code, 0)
    console.log("Module-path regression reproduced; fixed helper reaches consent without copying files")
  } finally {
    if (old) registry(["add", "HKCU\\Environment", "/v", "Path", "/t", old.type, "/d", old.value, "/f"])
    else registry(["delete", "HKCU\\Environment", "/v", "Path", "/f"])
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
