import { compileBinary } from "./compile-binary"
import { validateBinaryTarget } from "./binary-targets"
import { buildJscdn } from "./build-jscdn"
import { buildBakedAssets } from "./build-baked-assets"

import { buildDependencyBundle } from "./build-dependency-bundle"

validateBinaryTarget(process.env.BUN_BUILD_TARGET)
await buildJscdn()
await buildBakedAssets()
await buildDependencyBundle()
await compileBinary()
