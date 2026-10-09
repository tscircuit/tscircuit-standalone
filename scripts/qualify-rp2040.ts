// Build-time qualification only. The exact reference is supplied locally and
// is not included in the catalog or compiled runtime.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { getBundledFootprintCircuitJson, getBundledPart } from "../lib/catalog"

const referencePath = process.argv[2]
if (!referencePath) {
  throw new Error("Usage: bun scripts/qualify-rp2040.ts <pinned-RP2040-reference.tsx>")
}
const source = await readFile(referencePath, "utf8")
const referencePads = [...source.matchAll(
  /<smtpad portHints=\{\["(pin\d+)"\]\} pcbX="([^"]+)mm" pcbY="([^"]+)mm" width="([^"]+)mm" height="([^"]+)mm" shape="rect"/g,
)].map((match) => ({
  pin: match[1]!, x: Number(match[2]), y: Number(match[3]),
  width: Number(match[4]), height: Number(match[5]),
}))
assert.equal(referencePads.length, 57, "Expected the pinned 57-pad RP2040 reference")
assert.equal(new Set(referencePads.map((pad) => pad.pin)).size, 57)
const part = getBundledPart("C2040")
const compactPads = getBundledFootprintCircuitJson(part).filter(
  (pad) => pad.type === "pcb_smtpad",
)
assert.equal(compactPads.length, 57)
let maxCenterErrorMm = 0
let maxSizeErrorMm = 0
let intersections = 0
let union = 0
const matchedPins = new Set<string>()
for (const pad of compactPads) {
  assert.equal(pad.shape, "rect")
  if (pad.shape !== "rect") throw new Error("Expected rectangular QFN pads")
  const pin = pad.port_hints?.find((hint) => /^pin\d+$/.test(hint))
  assert.ok(pin, "Every compact pad needs a physical pin")
  assert.ok(!matchedPins.has(pin), "Physical pins must map one to one")
  matchedPins.add(pin)
  const exact = referencePads.find((referencePad) => referencePad.pin === pin)
  assert.ok(exact, `Missing reference pad ${pin}`)
  maxCenterErrorMm = Math.max(maxCenterErrorMm, Math.hypot(pad.x - exact.x, pad.y - exact.y))
  maxSizeErrorMm = Math.max(maxSizeErrorMm, Math.abs(pad.width - exact.width), Math.abs(pad.height - exact.height))
  const intersectionWidth = Math.max(0,
    Math.min(pad.x + pad.width / 2, exact.x + exact.width / 2) -
    Math.max(pad.x - pad.width / 2, exact.x - exact.width / 2))
  const intersectionHeight = Math.max(0,
    Math.min(pad.y + pad.height / 2, exact.y + exact.height / 2) -
    Math.max(pad.y - pad.height / 2, exact.y - exact.height / 2))
  const intersection = intersectionWidth * intersectionHeight
  intersections += intersection
  union += pad.width * pad.height + exact.width * exact.height - intersection
}
assert.equal(matchedPins.size, 57)
const copperIoU = intersections / union
assert.ok(copperIoU > 0.98, "Compact footprint must exceed the CLI admission threshold")
console.log(JSON.stringify({
  footprint: part.footprint, sourcePadCount: referencePads.length,
  compactPadCount: compactPads.length, maxCenterErrorMm, maxSizeErrorMm, copperIoU,
}, null, 2))
