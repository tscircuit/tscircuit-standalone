import { expect, test } from "bun:test"
import { embedCliEvalWorker } from "../scripts/cli-package-adapters"

test("published CLI worker embedding preserves the surrounding JavaScript and asset quoting", () => {
  const asset =
    'const worker = "<--INJECT_TSCIRCUIT_EVAL_WEB_WORKER_BLOB_URL-->"; const label = "user\'s circuit";'
  const literal = `'${asset.replaceAll("'", "\\'")}'`
  const source = `const before = 1; var standalone_min_default = ${literal}; const after = 2;`
  const embedded = embedCliEvalWorker(source, "d29ya2Vy")
  const result = new Function(
    `${embedded}; return { asset: standalone_min_default, before, after };`,
  )()
  expect(result.before).toBe(1)
  expect(result.after).toBe(2)
  expect(result.asset).toContain('atob("d29ya2Vy")')
  expect(result.asset).toContain("user's circuit")
  expect(result.asset).not.toContain("<--INJECT_")
})

test("changed published CLI asset layouts fail during the build", () => {
  expect(() => embedCliEvalWorker("const unrelated = 1", "")).toThrow(
    "asset is missing",
  )
  expect(() =>
    embedCliEvalWorker('var standalone_min_default = "changed";', ""),
  ).toThrow("placeholder is missing")
})
