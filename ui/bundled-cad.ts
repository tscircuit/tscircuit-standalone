import { configureTextBuilder } from "troika-three-text"

let configured: Promise<void> | undefined

/** Initialize the bundled CAD engine and font before any viewer mounts. */
export function configureBundledCad(): Promise<void> {
  configured ??= (async () => {
    configureTextBuilder({
      defaultFontURL: "/assets/font.ttf",
      useWorker: false,
    })
    const { default: createManifold } = await import("/assets/manifold.js")
    const manifold = await createManifold({
      locateFile: () => "/assets/manifold.wasm",
    })
    manifold.setup()
    window.ManifoldModule = manifold
  })()
  return configured
}
