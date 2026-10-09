import type { ComponentType } from "react"
import type { RunFrameProps } from "../node_modules/@tscircuit/runframe/lib/components/RunFrame/RunFrameProps"
import type { RunFramePlatformConfig } from "../node_modules/@tscircuit/runframe/lib/components/RunFrame/RunFramePlatformConfig"

// The composite source pin includes cherry-picked changes from unmerged PRs.
// Each PR remains open for review; using this pin does not merge any PR.
// Check host JSX against the pinned upstream props without checking unrelated
// upstream cloud features that the browser bundler removes or replaces. Runtime
// resolution still imports the real source component in scripts/build-ui.ts.
export declare const RunFrame: ComponentType<RunFrameProps>
export type { RunFrameProps, RunFramePlatformConfig }
