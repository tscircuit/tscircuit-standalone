import { expect, test } from "bun:test"
import { join } from "node:path"

const powershell = Bun.which("pwsh")
test.skipIf(!powershell)("Windows bootstrap validates downloads and preserves explicit takeover consent", () => {
  const result = Bun.spawnSync([powershell!, "-NoProfile", "-File", join(import.meta.dir, "windows-bootstrap.test.ps1")], {
    stdout: "pipe", stderr: "pipe",
  })
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0)
}, 30_000)
