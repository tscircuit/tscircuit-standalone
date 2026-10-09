import type { ComponentType } from "react"
import type { RunFrameProps } from "../node_modules/@tscircuit/runframe/lib/components/RunFrame/RunFrameProps"

// Check host JSX against the pinned upstream props without checking unrelated
// upstream cloud features that the browser bundler removes or replaces. Runtime
// resolution still imports the real source component in scripts/build-ui.ts.
export declare const RunFrame: ComponentType<RunFrameProps>
export type { RunFrameProps }
