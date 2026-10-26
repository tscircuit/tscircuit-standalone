import { compileBinary, validateBinaryTarget } from "./compile-binary"
import { buildJscdn } from "./build-jscdn"
import { buildBakedAssets } from "./build-baked-assets"

validateBinaryTarget(process.env.BUN_BUILD_TARGET)
await buildJscdn()
await buildBakedAssets()
await compileBinary()
