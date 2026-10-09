declare module "*.css" {}

interface Window {
  ManifoldModule?: import("manifold-3d").ManifoldToplevel
}

// Troika 0.52.5 provides JavaScript only. Keep this declaration limited to the
// documented bootstrap API the standalone UI uses.
declare module "troika-three-text" {
  export function configureTextBuilder(options: {
    defaultFontURL?: string
    unicodeFontsURL?: string
    sdfGlyphSize?: number
    sdfExponent?: number
    sdfMargin?: number
    textureWidth?: number
    useWorker?: boolean
  }): void
}
