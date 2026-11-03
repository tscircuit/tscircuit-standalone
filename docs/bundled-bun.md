# Bundled Bun runtime

The standalone executable is built with `Bun.build({ compile: ... })`, retaining
the full Bun CLI. `BUN_BE_BUN=1 tsci --version` runs the embedded Bun CLI instead
of the tscircuit entrypoint. Do not replace this build with `bun compile` or a
trimmed executable without requalifying the internal runtime.

`tsci internal bun <args...>` is the standalone interception point for Bun
commands. It starts the same executable with `BUN_BE_BUN=1` in the child's
environment, forwards standard streams and signals, and returns the child status.
It runs before asset extraction and shared CLI initialization. The parent does
not enter Bun CLI mode.

During normal standalone startup, `TSCIRCUIT_NODE_RUNTIME` defaults to a quoted
command prefix for that executable's `internal bun` entrypoint. An explicit
prefix can select a custom interception wrapper. The build adapter routes the
published CLI's Bun availability probe and package-manager commands through this
runtime, including install, add, remove, update, init and agent global installs.
The adapter checks the pinned CLI's layout during compilation. Other package
manager selections and the ordinary, separately installed CLI are unaffected.

Automatic project installation remains enabled. Bundling Bun removes the need
for a system Bun executable; it does not make uncached dependencies available
offline. Registry access, cache preparation and a future offline-install policy
remain separate work.

Validation includes a compiled runtime test with an empty PATH and local package
archives, plus `scripts/smoke-internal-bun.ts`. The latter runs actual standalone
`init` and `add` commands against a loopback registry with an empty package cache
and a deliberately failing system Bun. The full binary smoke check runs this
qualification with external networking disabled; native macOS and Windows CI run
the same package-operation checks.
