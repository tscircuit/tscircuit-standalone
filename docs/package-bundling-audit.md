# Audit of package-specific bundling workarounds

This audit covers the recent published-CLI migration and release repairs,
especially PRs #33, #42, #46, #47 and #48. The native runtime and browser asset
problems have different upstream causes.

## Native runtime cleanup

| Previous workaround | Why it existed | Replacement |
| --- | --- | --- |
| Extract an evaluator worker from a minified CLI string and replace a placeholder | CLI served RunFrame's raw bundle instead of tscircuit's complete browser export | CLI PR #5699 reads the public `tscircuit/browser` export |
| Rewrite `importFromUserLand`, `__require` and `getTscircuitDependencyVersion` | A compiled application no longer had the CLI's expected package layout | Restore a normal installed runtime project and execute its public CLI entrypoint in Bun mode |
| Map private worker paths to standalone worker wrappers | Compiled package-relative workers did not have normal files | Preserve published worker files and relative paths |
| Register React, tscircuit and the computed autorouter import in a Bun plugin | Flattening packages changed dynamic resolution and package boundaries | Normal installed dependency/peer graph |
| Substitute Resvg, Rollup, DTS plugin and WASM loader source | Native packages and runtime assets were forced through the compiler | Ship their actual package files and OS/CPU optional dependencies |
| Copy selected core/eval/props/schema pins from tscircuit into the root | Flattened graphs combined incompatible versions | Declare the top-level runtime release and let Bun resolve its dependencies |
| Compile the whole RunFrame/viewer graph to discover lazy imports | Discovery depended on unrelated transitive exports, including the release's solver and system-block-viewer failures | Use the importer's public module catalog and the UI dependency manifest |
| Override altiumts globally | The converter selected a Git checkout whose declared `dist` entrypoint was absent | Converter [PR #192](https://github.com/tscircuit/circuit-json-to-altium/pull/192) declares a published built package |

The native archive includes the installed project's manifest and lockfile as
well as its package files. The launcher compiles no CLI, core or exporter
implementation. The pack/restore code is generic and preserves package bytes,
internal links and executable modes.

The root runtime now declares only `@tscircuit/cli` and `tscircuit`.
Dependencies used by this repository's legacy library, build tools and tests
remain development dependencies; the UI has a separate workspace manifest.
The legacy UI declares the tscircuit SDK to provide evaluator peers through a normal dependency. Those graphs do not dictate the packaged production graph.

## Browser adapters that still need upstream changes

These are present in `scripts/ui-package-adapters.ts`; the native cleanup does
not claim to remove them.

| Current workaround | Correct upstream boundary |
| --- | --- |
| Exact GLTF version and hashed PNG chunk matching; browser/native PNG branch replacement | GLTF should publish conditional browser exports that select the browser rasterizer and package its WASM without source-string changes |
| Force STEP's GLTF dependency to an older UI version | STEP should declare a compatible converter and consume its public browser export; qualify STEP output before removing the redirect |
| Replace LBRN's hardcoded Manifold CDN URL | LBRN should accept a runtime factory or asset resolver, with its normal online behavior as the default |
| Intercept FDM's Manifold import and replace `setup()` with an idempotent wrapper | The exporter should own its runtime lifecycle and expose injection for a prepared Manifold instance |
| Add an ESM export to OCCT's CommonJS loader and override `locateFile` | Publish a supported browser ESM entrypoint and allow the caller to supply a local WASM URL |
| Manual viewer CDN aliases for Manifold, OCCT and fonts | Viewers should accept an asset resolver/manifest and share the normal loader APIs |
| Legacy RunFrame pins Core 0.0.1911, which imports an undeclared schematic solver | Keep the legacy build helper as a development dependency until RunFrame/Core publish a complete compatible graph; it is absent from the production manifest |
| Force React/Zod imports to one UI copy, and replace Troika's font resolver module | Declare compatible peer dependencies and use a public font-resolution configuration hook |

These fixes should be small PRs in the producing packages, followed by ordinary
version updates here. Adding another root override, guessed hashed chunk name,
module registration or string replacement would preserve the same failure mode.

## Qualification

Runtime/cache fixture tests cover real package restoration, data files,
dependency links, workers, literal argument forwarding and exit codes.
The JS CDN build must retain every currently shipped module. Actual binary
smoke tests cover init/install/add, sequential and worker builds, static-site
assets, browser module imports, WASM-backed geometry and absence of external
browser requests.

The two normal package trees increase payload and first-extraction size.
The CLI preview must be replaced by its published release before this is used
for a production release.
