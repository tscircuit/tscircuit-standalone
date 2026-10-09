import type { AnyCircuitElement } from "circuit-json"

export interface StandaloneBuildJob {
  fsMap: Record<string, string>
  mainComponentPath: string
}

export type StandaloneBuildResult =
  | { ok: true; circuitJson: AnyCircuitElement[] }
  | { ok: false; error: string }
