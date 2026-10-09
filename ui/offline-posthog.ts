// The standalone browser build excludes telemetry even if a future UI feature
// accidentally calls the SDK. No SDK code or network transport is bundled.
export default {
  __loaded: false,
  init() {},
  identify() {},
  capture() {},
  captureException() {},
}
