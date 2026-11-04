# Package installation and offline runtime

Standalone packages two normal filesystem trees: the CLI runtime project and
Bun's native install cache. It does not rewrite package files or register
package-specific runtime modules.

## Build

The production manifest declares the CLI and selected `tscircuit` release.
`scripts/build-bun-cache.ts` installs that manifest in an isolated project,
including optional dependencies for every supported OS and CPU. Bun resolves
transitive and peer dependencies. The installed project's manifest, lockfile,
`node_modules`, workers, data files and native modules are archived together.

The same script invokes that CLI's `init --yes --no-install` and installs the
generated project to warm the native cache. Standalone does not maintain a
second list of init dependencies. Build inputs retain both resolved lockfiles,
the generated init manifest, both archives and their license inventories.
Cached tags such as `latest` are snapshots taken during preparation.

Release preparation selects only the top-level `tscircuit` version. Development
and UI dependencies belong to their own graphs; they are not copied into, or
used to override, the production runtime.

## Launch

The executable restores each archive into a Bun-version- and content-specific
cache directory using staged extraction and an atomic rename. Published file
contents stay unchanged; transport metadata preserves executable permissions
and internal links. Windows uses directory junctions where symlink privileges
would otherwise be required. `TSCIRCUIT_CACHE_DIR` overrides the cache root.

A small compiled launcher starts the restored public CLI entrypoint using its
own executable with child-only `BUN_BE_BUN=1`. This uses ordinary Bun filesystem
resolution, including relative worker entrypoints and package exports. It
forwards arguments, terminal streams, exit codes, SIGINT and SIGTERM. No Bun
installation or change to the user's PATH is required.

`TSCIRCUIT_NODE_RUNTIME` and `TSCIRCUIT_NODE_RUNTIME_ARGS` pass the same
executable and a private bunfig to the CLI's existing runtime hook. The config
sets `install.offline = true`, `install.ignoreScripts = true` and the restored
native cache directory. Install/add/remove use Bun itself; misses fail locally.
Project and global bunfig files stay untouched.

Project dependency resolution follows the published CLI. The child appends the
restored node_modules directory to Bun's standard NODE_PATH search path, so bare
projects can use the bundled SDK. Project-local packages retain priority;
standalone no longer forces selected React, tscircuit or autorouter modules
through a Bun registration plugin.

## Browser packages

CLI [PR #5699](https://github.com/tscircuit/cli/pull/5699) serves the installed
`tscircuit/browser` export for standalone dev and static sites. That producer
already embeds its matching evaluator worker. Standalone no longer edits the
CLI's minified JavaScript to inject one. Until that fix is released, the manifest
uses the public package preview from its validation workflow.

The local JS CDN bundles UI-declared dependencies that appear in
`internal-dynamic-import`'s exported `supportedModules` catalog. It does not
compile RunFrame and its viewers just to discover import calls.

Browser exporter asset adapters still exist in `ui-package-adapters.ts`.
Removing those requires upstream browser entrypoints and asset URL contracts;
the native runtime refactor does not make those exporters universally portable.
The package-specific follow-ups are recorded in [the packaging audit](package-bundling-audit.md).

## Verification and limits

`tests/packaged-runtime.test.ts` compiles a launcher fixture and checks restored
package exports, a relative worker, package data, dependency links, literal
arguments and a nonzero exit code with an empty PATH.

`tests/native-bun.test.ts` checks real native install/add/remove behavior,
uncached versions and URLs, lifecycle suppression and private-config precedence.
Fixture-registry requests must stay at zero during offline operations. The full
binary smoke tests exercise actual CLI commands and browser execution.

The cache and complete runtime project both take space in the executable and
on first extraction. This preserves package boundaries at the cost of a larger
payload. User-authored programs and arbitrary Bun commands are not sandboxed.
