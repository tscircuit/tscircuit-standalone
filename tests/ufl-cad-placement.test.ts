import { expect, test } from "bun:test"
import React from "react"
import * as jscad from "@jscad/modeling"
import { Circuit } from "@tscircuit/core"
import { createStandalonePlatformConfig } from "../lib/platform"
import { getJscadModelForFootprint } from "jscad-electronics/vanilla"

test("U.FL CAD terminals align with real core pads after board placement", async () => {
  const originalFetch = globalThis.fetch
  const networkRequests: string[] = []
  const rejectRequest = (input: unknown) => {
    networkRequests.push(String(input))
    throw new Error(`Unexpected network request: ${String(input)}`)
  }
  const deniedFetch = Object.assign(async (input: unknown) => rejectRequest(input), { preconnect: rejectRequest }) as typeof fetch
  globalThis.fetch = deniedFetch
  try {
    for (const [footprint, x, y, rotation] of [
      ["ufl3", 0, 0, 0],
      ["ufl3", -18, 3, 90],
      ["ufl_p3.2mm_pw2mm_signalw1.4mm_signalx-1.3mm", 2, -1, 180],
      ["ufl3", -2, 1, 270],
    ] as const) {
      const circuit = new Circuit({
        platform: {
          ...createStandalonePlatformConfig(),
          platformFetch: deniedFetch,
        },
      })
      circuit.add(
        React.createElement(
          "board",
          { width: 50, height: 20 },
          React.createElement("chip", {
            name: "J_RF",
            footprint,
            pinLabels: { pin1: "GND1", pin2: "RF", pin3: "GND2" },
            pcbX: x,
            pcbY: y,
            pcbRotation: rotation,
          }),
        ),
      )
      await circuit.renderUntilSettled()
      const json = circuit.getCircuitJson()
      const pcb = json.find((e) => e.type === "pcb_component")!
      const cad = json.find((e) => e.type === "cad_component")!
      const pads = json.filter((e) => e.type === "pcb_smtpad" && e.shape === "rect")
      expect(pcb.center.x).toBeCloseTo(x, 6)
      expect(pcb.center.y).toBeCloseTo(y, 6)
      expect(cad.position.x).toBeCloseTo(x, 6)
      expect(cad.position.y).toBeCloseTo(y, 6)
      expect(cad.footprinter_string).toBe(footprint)
      if (!cad.rotation) throw new Error("U.FL CAD placement lost its board rotation")
      expect(cad.rotation.z).toBe(rotation)
      const radians = (cad.rotation.z * Math.PI) / 180
      const { geometries } = getJscadModelForFootprint(footprint, jscad)
      const worldBounds = geometries.map(({ geom }: any) =>
        jscad.measurements.measureBoundingBox(
          jscad.transforms.translate(
            [cad.position.x, cad.position.y, cad.position.z],
            jscad.transforms.rotateZ(radians, geom),
          ),
        ),
      )
      const lowMetal = worldBounds.filter(
        ([min, max]: any) =>
          Math.abs(min[2] - cad.position.z) < 1e-6 &&
          Math.abs(max[2] - cad.position.z - 0.1) < 1e-6,
      )
      expect(lowMetal).toHaveLength(4)
      expect(pads).toHaveLength(3)
      const landings = pads.map((pad: any) => {
        // Core emits oriented rectangles for right-angle PCB rotations.
        const padBounds = jscad.measurements.measureBoundingBox(
          jscad.primitives.cuboid({
            size: [pad.width, pad.height, 0.1],
            center: [pad.x, pad.y, cad.position.z + 0.05],
          }),
        )
        return lowMetal.filter(([min, max]: any) =>
          [0, 1].every(
            (axis) =>
              Math.min(max[axis], padBounds[1][axis]) -
                Math.max(min[axis], padBounds[0][axis]) >
              1e-6,
          ),
        )
      })
      expect(landings.map((landing: any[]) => landing.length)).toEqual([1, 1, 1])
      const shell = worldBounds.find(
        ([min, max]: any) => Math.abs(max[2] - cad.position.z - 1.25) < 1e-6,
      )!
      const grounds = pads.filter((pad: any) =>
        pad.port_hints?.some((hint: string) =>
          ["1", "3", "pin1", "pin3"].includes(hint),
        ),
      )
      expect(grounds).toHaveLength(2)
      for (const [axis, coordinate] of [[0, "x"], [1, "y"]] as const) {
        expect((shell[0][axis] + shell[1][axis]) / 2).toBeCloseTo(
          (grounds[0][coordinate] + grounds[1][coordinate]) / 2,
          6,
        )
      }
    }
    expect(networkRequests).toEqual([])
  } finally {
    globalThis.fetch = originalFetch
  }
})
