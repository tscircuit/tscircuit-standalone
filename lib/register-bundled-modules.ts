import * as tscircuit from "tscircuit"

// Authored TSX and the CLI's dynamic imports need modules without node_modules.
const modules: Record<string, Record<string, unknown>> = {
  react: require("react"),
  "react/jsx-runtime": require("react/jsx-runtime"),
  "react/jsx-dev-runtime": require("react/jsx-dev-runtime"),
  tscircuit,
}
Bun.plugin({
  name: "standalone-runtime-modules",
  setup(build) {
    for (const [name, exports] of Object.entries(modules)) {
      build.module(name, () => ({ loader: "object", exports }))
    }
  },
})
