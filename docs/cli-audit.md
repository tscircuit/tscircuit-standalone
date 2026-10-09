# CLI, import catalog, and binary audit

Scope: read-only investigation of `tscircuit/cli` at local commit `60256bbff0ab38b761e2cea8c6419ce073c528c5` (`@tscircuit/cli@0.1.2270`), plus pinned public catalog sources. This is evidence for the standalone implementation plan, not a claim that the existing CLI works offline.

## Import pipeline

- [cli/import/register.ts](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/cli/import/register.ts) registers `tsci import`. Its default JLC search is a direct global `fetch` to `https://jlcsearch.tscircuit.com/api/search?limit=10&q=<query>`. It expects `{components: [{lcsc: number, mfr: string, package: string, description: string, price: number}]}`. Even exact `C2040` first goes through this search. A direct LCSC fallback is attempted only after empty search results.
- Registry imports POST `packages/search` through `getRegistryApiKy()` and call `addPackage()` to install the chosen package.
- [lib/import/import-component-from-jlcpcb.ts](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/lib/import/import-component-from-jlcpcb.ts) calls `fetchEasyEDAComponent(partNumber)` without an injected fetch, fetches datasheet pin attributes unless excluded, converts raw EasyEDA to Circuit JSON/TSX, then optionally replaces the exact footprint with a footprinter string. It writes `imports/<normalized-MPN>.tsx`.
- [lib/import/fetch-datasheet-pin-attributes.ts](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/lib/import/fetch-datasheet-pin-attributes.ts) directly fetches `<registryApiUrl>/datasheets/get?chip_name=rp2040`, expecting `{datasheet: {chip_name, pin_attributes}}`.
- Import conversion uses `useModelCdn: true` and adds remote CAD object/STEP URLs. `--download` fetches those assets. A compact footprint alone does not remove these later requests.
- Import currently does not load project runtime `platformConfig`. A custom platform configuration cannot currently replace this entire command.

Recommendation: expose a catalog/import resolver hook in the CLI/platform integration, check exact supplier aliases locally before search, and generate the component source from a validated compact catalog record. Unknown imports should fail explicitly without fallback. Do not emulate raw EasyEDA responses to keep using the network importer: raw EasyEDA is much larger than the compact chip representation the user wants.

## Compact footprint eligibility

[convert-imported-footprint-to-footprinter.ts](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/lib/import/footprinter/convert-imported-footprint-to-footprinter.ts) already implements a useful admission policy:

1. Call `circuitJsonToFootprinter(circuitJson, {maxCandidates: 5, sourceHints})`.
2. Require copper intersection-over-union strictly greater than `0.98`.
3. Parse the candidate with `fp.string(...).circuitJson()`.
4. Require equal pad counts and a complete physical pin mapping.
5. Reject remaps whose aliases would collide with another target physical pin, because core matches attributes against every alias.

The results are `footprinter`, `exact-low-accuracy`, `exact-discovery-failed`, or `exact-pin-conflict`. Only `footprinter` should enter the initial standalone catalog. Existing CLI keeps exact geometry for rejected cases; standalone should omit them and record the rejection reason.

[replace-exact-footprint.ts](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/lib/import/footprinter/replace-exact-footprint.ts) adds a `thermalpad` alias to `pin57` when appropriate. The corresponding test file includes a QFN-56 thermal-pad case and a separate alias-collision rejection case. Preserve these mappings in compact records. Copper IoU is a geometric check, not a complete manufacturer land-pattern/signals qualification.

Suggested catalog record: supplier ID, MPN, component export name, compact footprint string, full pin labels/aliases, curated pin attributes, description/search aliases, source URL+commit, footprinter/converter version, IoU and admission decision. Keep runtime data small and omit remote CAD/datasheet references. Acquisition and qualification can use networking at build time.

## RP2040 / C2040 provenance and validation

Compact source:

- Repository: `tscircuit/common`, commit `a5797da88ec19944442d87392174af0a36fe1a0a`, release `v0.0.65`.
- [lib/Microcontroller_RP2040/imports/RP2040.tsx](https://github.com/tscircuit/common/blob/a5797da88ec19944442d87392174af0a36fe1a0a/lib/Microcontroller_RP2040/imports/RP2040.tsx), blob `163e457177c04d7229e8c71bfa5328641b8ef6bd`.
- Exact identity in source: `manufacturerPartNumber="RP2040"`, `supplierPartNumbers={{jlcpcb: ["C2040"]}}`.
- Footprint: `qfn56_thermalpad3.1mmx3.1mm_p0.4001mm_w7.8999mm_h7.9001mm_pw0.2mm_pl0.85mm`.
- 56 numbered signal/power pads plus thermal pad. Source maps `pin57: ["GND", "thermalpad"]`.
- Source includes remote CAD object/STEP URLs. These must be removed for the initial catalog.
- [MIT license](https://github.com/tscircuit/common/blob/a5797da88ec19944442d87392174af0a36fe1a0a/LICENSE), Copyright (c) 2025 tscircuit; retain notice with adapted pin labels.

Reference geometry used only for comparison:

- `tscircuit/jlc100@a5f09d9c9ea7a5d845bfcc07ec8d7c7b72367073`, [lib/microcontrollers/RP2040.tsx](https://github.com/tscircuit/jlc100/blob/a5f09d9c9ea7a5d845bfcc07ec8d7c7b72367073/lib/microcontrollers/RP2040.tsx), blob `49ccc699326571315bdb7efd590fd44f62f98cc3`. It has 57 exact rectangular EasyEDA pads.

Reproducible build-time check: obtain the exact reference TSX at the pinned link above, then run `bun scripts/qualify-rp2040.ts <path-to-reference.tsx>`. It uses the pinned `@tscircuit/footprinter@0.0.430`, parses the compact string, matches each numbered pad to its reference rectangle, maps thermalpad to pin57, asserts all 57 pads uniquely correspond, and sums per-pad intersection/union area. Pads are disjoint in this footprint. The reference is supplied locally for qualification and is not included in the runtime catalog.

Observed results:

| Check | Result |
| --- | --- |
| Reference pad count | 57 |
| Compact pad count | 57 |
| Copper intersection-over-union | 0.9981788348844475 (99.8179%) |
| Maximum same-pin center deviation | 0.0007061196783051484 mm |
| Maximum pad-size deviation | 0.000010999999999872223 mm |
| Thermal pad | 3.1 × 3.1 mm, center (0, 0), port hint thermalpad |

This exceeds the existing CLI's >98% admission threshold and preserves physical pin ordering. It does not validate all electrical pin attributes or manufacturing export behavior; add a rendered circuit regression for pin57/GND attachment in the actual standalone foundation.

## Popular catalog sources

- [tscircuit/jlc100](https://github.com/tscircuit/jlc100) describes top 100 popular components per category, currently 30 processors and 32 microcontrollers. Most checked-in imports still carry exact footprints, so use as a candidate list and qualify before bundling. Do not import it wholesale.
- [tscircuit/jlc5000](https://github.com/tscircuit/jlc5000) is a stock-ranked exact-footprint benchmark dataset; its README reports 600 accepted structurally unique footprints. It excludes common passive packages and boosts difficult mechanical packages. Its candidates/manifest/imports plus benchmark reports are useful offline-build inputs, but its ranking is not usage popularity and many footprints will fail compact admission.
- `tscircuit/common` provides curated compact circuit imports such as the RP2040 source above. Use pinned sources and supplier IDs to seed a small verified catalog, then expand via the build-time qualification pipeline.

## Platform and dev integration

- [get-platform-config-with-cli-defaults.ts](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/lib/shared/get-platform-config-with-cli-defaults.ts) starts with eval defaults, sets `checkAvailability: true`, adds a disk cache and KiCad file loader, then merges user overrides. Standalone should create offline defaults directly or ensure its invariant overrides survive merging.
- Existing `PlatformConfig` supports `partsEngine`, `footprintLibraryMap`, `platformFetch`, `nodeModulesResolver`, static loaders, local cache, `partsEngineDisabled`, `checkAvailability`, `useCloudAutorouter`, simulation flags and engine maps. These cover runtime rendering but not every CLI command.
- [lib/project-config/index.ts](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/lib/project-config/index.ts) supports `tscircuit.config.ts/js` with function-valued `platformConfig`; JSON project config does not. Build workers already reload runtime project config locally so function values are not transferred by structured clone. Preserve that pattern and instantiate standalone config per worker.
- `DevServer.ts` currently loads JSON-only project config at construction and does not accept a runtime platform factory for browser evaluation.
- [lib/site/getIndex.ts](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/lib/site/getIndex.ts) contains a remote Tailwind script (`cdn.tailwindcss.com`) and GitHub favicon.
- [lib/server/createHttpServer.ts](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/lib/server/createHttpServer.ts) normally embeds RunFrame text or uses a local tscircuit browser bundle. An invalid explicit `RUNFRAME_STANDALONE_FILE_PATH` causes a jsDelivr redirect. Standalone must serve embedded/local-only UI assets and surface missing assets without a CDN fallback.
- Local loopback file server/cache requests are essential to `dev`; distinguish these from outbound requests. Test browser requests as well as Node requests.

## Existing packaging is not a standalone binary

- [cli/entrypoint.js](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/cli/entrypoint.js) spawns an externally installed Bun or tsx process and can prefer a project's local CLI.
- [scripts/bun-build.ts](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/scripts/bun-build.ts) targets Node, emits multiple JS entrypoints, and externalizes tscircuit, React, TypeScript and most tscircuit dependencies. It is an npm package build, not `bun build --compile`.
- [generate-circuit-json.tsx](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/lib/shared/generate-circuit-json.tsx) loads React/tscircuit from userland then imports a user file by filesystem URL. [importFromUserLand.ts](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/lib/shared/importFromUserLand.ts) resolves node_modules and finally dynamically imports a bare module, which may cause Bun auto-install. Use an explicit embedded resolver, reject unbundled dependencies and disable runtime auto-install.
- Build and snapshot worker pools look for sibling `.ts/.js` files on disk. Compile/include explicit worker entries or extract versioned embedded assets. Do not assume the npm bundle's path heuristics work inside a compiled executable.
- [lib/index.ts](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/lib/index.ts) only exports the server/dev classes, dependency analysis and KiCad APIs. Command registration and JSON generation are not public stable API exports. `cli/main.ts` eagerly registers all command groups and parses argv.

## Recommended upstream changes / sequence

1. Build a small standalone package: compact catalog, closed local platform config, exact-ID import/search and explicit unsupported command errors. Compile a binary prototype before claiming legacy CLI feature parity.
2. Expose a configurable CLI factory/public registration APIs, with injected platform factory, catalog/import resolver, module resolver, worker entries and asset provider. Disable/remove network command groups such as auth/push/install/update in standalone capability registration.
3. Thread standalone platform into all renderer paths and instantiate it in workers. Make Node import resolution use embedded dependencies and local files without auto-install.
4. Inject RunFrame's platform in both parent UI and evaluation iframe; embed CSS/favicon/scripts/wasm/worker assets and eliminate CDN fallbacks. Add a local platform serialization/bootstrap mechanism instead of serializing functions over HTTP.
5. For each enabled command, exercise success, unknown catalog entry, missing dependency and project override paths under an OS network-denied harness. Record browser outbound attempts while allowing loopback dev/cache traffic. A patched `fetch` alone is not sufficient evidence because SDKs, loaders, raw HTTP clients, workers and subprocesses can bypass it.
6. Verify clean-machine compiled binaries without Bun/Node/npm installed, then produce per-platform checksums and release artifacts. Validate initial platform selection and sizes using the small catalog before scaling.

Keep the initial advertised capability set narrow until build/dev/export browser and binary tests pass. The scoped standalone foundation should not import the entire legacy CLI entrypoint.
