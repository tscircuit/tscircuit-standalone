import { gunzipSync, strFromU8 } from "fflate"
import { bundledPartsGzipBase64 } from "./generated-bundled-parts"

// API acquisition, pin adaptation and admission happen when the binary is built.
// Runtime only decodes the embedded definitions; createCatalog validates them.
const bytes = Uint8Array.from(atob(bundledPartsGzipBase64), (character) =>
  character.charCodeAt(0),
)
export const bundledParts: readonly unknown[] = JSON.parse(strFromU8(gunzipSync(bytes)))
