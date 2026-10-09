export type UiAsset = {
  content: string | Uint8Array
  contentType: string
}

// scripts/build-ui.ts creates this module before compiling the binary.
export { uiAssets } from "./generated-ui-assets"
