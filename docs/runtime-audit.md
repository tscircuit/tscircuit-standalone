# Standalone runtime audit and upstream integration plan

This audit records the original upstream snapshots below. The standalone path
now supplies local catalog/build/dev commands and composes ordinary RunFrame
source execution with a bundled browser worker, dynamic imports, and local
platform providers. The merged changes and remaining style patch are described
in [bundled RunFrame](offline-runframe.md). Findings and source links below refer
to the original snapshots, not the current bundle. Revised compiled-browser
qualification is recorded in the linked RunFrame document; wider reusable policy
work remains in the [implementation plan](implementation-plan.md).

## Source snapshots

- `@tscircuit/props`: local checkout `42da28792ffd374109b367133e562bac9ab8db97`, matching the live GitHub tree read during this audit.
- `@tscircuit/core`: local checkout `6a195d6500033025331a1cc5533284866bb69819`. GitHub's search index pointed at a different commit; core findings below use the local snapshot and its permalinks.
- `@tscircuit/cli`: local checkout `60256bbff0ab38b761e2cea8c6419ce073c528c5`.
- `@tscircuit/eval`: GitHub tree `bc8c3d4710066ec2c19008bcffeec50c998ed21f`. Every inspected source blob was checked against this tree's blob SHA.
- `@tscircuit/runframe`: GitHub tree `5655ad20182173230998002710dbab989e5bdde9`. Every inspected source blob was checked against this tree's blob SHA.

## Existing extension points

[`PlatformConfig`](https://github.com/tscircuit/props/blob/42da28792ffd374109b367133e562bac9ab8db97/lib/platformConfig.ts#L66) already provides `partsEngine`, `footprintLibraryMap`, `footprintFileParserMap`, `staticFileLoaderMap`, `nodeModulesResolver`, `resolveProjectStaticFileImportUrl`, `platformFetch`, `spiceEngineMap`, and routing controls. A standalone catalogue does not need a new chip-specific core API.

[`PartsEngine`](https://github.com/tscircuit/props/blob/42da28792ffd374109b367133e562bac9ab8db97/lib/components/group.ts#L303) requires `findPart({ sourceComponent, footprinterString? })`, returning supplier part numbers. Its optional `fetchPartCircuitJson({ supplierPartNumber?, manufacturerPartNumber?, platformFetch? })` returns Circuit JSON or undefined. `fetchPartAvailability` is optional. A local catalogue adapter should answer known parts through these APIs, generate footprint Circuit JSON from its compact footprinter string, preserve pin/manufacturer/supplier metadata, and never fall back to a remote provider. Availability should remain disabled because bundled stock data cannot be current.

[`RunFrameProps`](https://github.com/tscircuit/runframe/blob/5655ad20182173230998002710dbab989e5bdde9/lib/components/RunFrame/RunFrameProps.tsx) already has `platformConfig`, `evalWebWorkerBlobUrl`, and `evalVersion`. [`createCircuitWebWorker`](https://github.com/tscircuit/eval/blob/bc8c3d4710066ec2c19008bcffeec50c998ed21f/lib/worker.ts#L227) walks config object paths and proxies functions with Comlink. Returning plain catalogue records/Circuit JSON is suitable for this boundary. A native `Response` returned by an arbitrary proxied `platformFetch` should not be assumed to transfer: Comlink's structured-clone boundary does not automatically support the native Response object. A worker-local catalogue factory avoids that dependency and avoids transporting every generated footprint between threads.

## Current integration against these snapshots

Standalone dev serves a bounded source `fsMap` and an embedded eval 0.0.1569
worker; RunFrame performs its usual browser execution through CircuitRunner
and Comlink. The worker constructs local providers, installs request guards
before evaluator initialization, and validates authored circuits and returned
JSON. A static JSON entry uses RunFrame's existing file-viewing branch with
array/element and asset validation; unknown part metadata is permitted because
viewing already-rendered geometry requires no part lookup. Native CLI build
continues to use its separate embedded worker. Browser execution has no deadline
yet; a generic execution-timeout API remains follow-up work.

The current UI injects a twelve-package lazy dependency manifest through
internal-dynamic-import: Altium, ten RunFrame converter packages, and schematic
placement analysis 0.0.46. The app uses public `@tscircuit/runframe/runner`
exports and the shared `@tscircuit/props` `PlatformConfig` through the existing
platform prop. Before app imports, `host-config.js` sets
`window.TSCIRCUIT_TELEMETRY_DISABLED = true` and
`window.TSCIRCUIT_ALLOW_SELECTING_EVAL_VERSION = false`; fresh profiles default
to canvas by storing `JSON.stringify("canvas")` under the existing
`pcb_viewer_rendering_engine` key only when no preference exists. The worker wrapper retains
`runner.setDisableCdnLoading(true)`. The schematic viewer uses the existing
parts-engine availability method, generates thumbnails locally, and loads
analysis through the generic importer. Manifold/fonts and converter WASM assets are bundled.
External hyperlinks and the existing autorouting-report callback retain normal
navigation; automatic application requests cannot require external access.
Host graph errors stay in the editor while RunFrame remains mounted; worker
errors follow its normal error path.

[RunFrame #5618](https://github.com/tscircuit/runframe/pull/5618),
[RunFrame #5643](https://github.com/tscircuit/runframe/pull/5643),
[schematic-viewer #285](https://github.com/tscircuit/schematic-viewer/pull/285),
[schematic-viewer #287](https://github.com/tscircuit/schematic-viewer/pull/287),
[internal-dynamic-import #35](https://github.com/tscircuit/internal-dynamic-import/pull/35),
[worker lifecycle #5632](https://github.com/tscircuit/runframe/pull/5632), and
[static JSON #5637](https://github.com/tscircuit/runframe/pull/5637) were merged
by the user. [Solver/styles #5631](https://github.com/tscircuit/runframe/pull/5631)
remains open and separate. Never merge PRs automatically. These
changes address selected integration gaps. The current enabled flows have fresh
compiled-browser qualification; wider asset/provider and export completeness
remain follow-up work.

Standalone uses published versions and public package entrypoints,
including RunFrame 0.0.2953, internal-dynamic-import 0.0.17, and schematic-viewer
2.0.104. The RunFrame artifact includes the merged changes; exact versions are
recorded in the dependency manifest and lockfile. Source subpaths and a composite cherry-picked
RunFrame branch are no longer required. Fresh local qualification passed frozen
installation with Bun 1.3.12, backend/UI types, 98 tests with 647 assertions,
binary build/notices, native clean-project smoke, and the complete Chromium
compiled-binary harness. All six views, twelve module namespaces, and thirteen
operations completed with 31 same-origin resources and two worker URLs; no
external attempts, CSP violations, browser/console errors, or local failures
were observed. Native tracing recorded no external socket, connect, or send
attempts. CI repeats the browser proof with only loopback networking; these
reported migration results are local.

The PRs keep package boundaries: RunFrame owns existing host configuration and
viewer forwarding, with worker lifecycle and static JSON reviewed separately;
schematic-viewer owns availability and local
thumbnails; internal-dynamic-import owns generic module resolution. Standalone
owns catalog providers, literal manifests, and packaging. No new fields are
added to the shared `@tscircuit/props` interfaces.

## Gaps recorded in the original snapshots

| Surface | Snapshot behavior and source | Integration requirement |
| --- | --- | --- |
| RunFrame worker startup | [`RunFrame.tsx:167`](https://github.com/tscircuit/runframe/blob/5655ad20182173230998002710dbab989e5bdde9/lib/components/RunFrame/RunFrame.tsx#L167) and its run path at line 329 resolve eval version before using an embedded worker. `resolveEvalVersion` fetches jsDelivr when no explicit version/window cache exists, even when `forceLatest` is false. | Embedded-worker startup must not resolve a version remotely. Supply explicit worker/version metadata and generic loader hooks rather than relying only on the CLI window global. |
| CLI RunFrame forwarding | [`RunFrameForCli.tsx:13`](https://github.com/tscircuit/runframe/blob/5655ad20182173230998002710dbab989e5bdde9/lib/components/RunFrameForCli/RunFrameForCli.tsx#L13) accepts worker URL and platform config, but no evalVersion; it disables `forceLatestEvalVersion` when embedded without preventing the lookup above. | Forward pinned eval version, worker URL, and platform through RunFrame wrappers. Recreate workers when their configuration changes; avoid global reuse across different provider policies. |
| Worker download | [`eval/lib/worker.ts:89`](https://github.com/tscircuit/eval/blob/bc8c3d4710066ec2c19008bcffeec50c998ed21f/lib/worker.ts#L89) fetches worker entrypoint from CDN fallbacks when worker URL is absent. | Supply the bundled worker explicitly and fail locally if it is unavailable; no CDN fallback in standalone. |
| Worker fetch proxy | [`eval/lib/worker.ts:123`](https://github.com/tscircuit/eval/blob/bc8c3d4710066ec2c19008bcffeec50c998ed21f/lib/worker.ts#L123) proxies worker requests to parent global fetch. It serializes responses as text. | `enableFetchProxy` is an online compatibility transport. Apply request policy before dispatch; use local worker providers/assets instead of text transport for binary WASM/model data. |
| Default providers restored | [`getPlatformConfig.ts:117`](https://github.com/tscircuit/eval/blob/bc8c3d4710066ec2c19008bcffeec50c998ed21f/lib/getPlatformConfig/getPlatformConfig.ts#L117) defaults to the JLC parts engine and additively installs networked KiCad footprints/parsers and a lazy ngspice provider. [`createExecutionContext`](https://github.com/tscircuit/eval/blob/bc8c3d4710066ec2c19008bcffeec50c998ed21f/lib/eval/execution-context.ts#L33) calls this even with a supplied platform. | Expose generic provider-default selection and ensure supplied local providers replace networked defaults. An empty map alone does not remove defaults. Keep local KiCad content parsers available without installing URL fetchers. |
| Project overrides | [`getPlatformConfigForTscircuitConfig.ts:22`](https://github.com/tscircuit/eval/blob/bc8c3d4710066ec2c19008bcffeec50c998ed21f/lib/getPlatformConfig/getPlatformConfigForTscircuitConfig.ts#L22) spreads project config over worker platform. | Request/provider policy belongs to the host/runtime and must survive project config merges. Reject or ignore project attempts to enable cloud providers; allow ordinary design overrides. |
| Registry imports | [`import-eval-path.ts:307`](https://github.com/tscircuit/eval/blob/bc8c3d4710066ec2c19008bcffeec50c998ed21f/lib/eval/import-eval-path.ts#L307) handles `@tsci/*` imports with `importSnippet` independently of `disableCdnLoading`; [`import-snippet.ts`](https://github.com/tscircuit/eval/blob/bc8c3d4710066ec2c19008bcffeec50c998ed21f/lib/eval/import-snippet.ts#L24) directly fetches registry CJS and assets. | Gate every remote import path. Resolve local files, embedded modules/catalogue-generated components and supplied modules first; unknown remote imports must fail without a request. |
| Simulation fallback | [`dynamically-load-dependency-with-cdn-backup.ts:22`](https://github.com/tscircuit/eval/blob/bc8c3d4710066ec2c19008bcffeec50c998ed21f/lib/utils/dynamically-load-dependency-with-cdn-backup.ts#L22) always falls back to CDN after local import failure. The default ngspice map invokes it. | Disable analog simulation initially or bundle engines/WASM completely with a local engine resolver. Missing native/embedded engines must error locally. |
| Core HTTP footprint | [`NormalComponent_doInitialPcbFootprintStringRender.ts:168`](https://github.com/tscircuit/core/blob/6a195d6500033025331a1cc5533284866bb69819/lib/components/base-components/NormalComponent/NormalComponent_doInitialPcbFootprintStringRender.ts#L168) uses global fetch for remote footprint URLs. | Route through the shared request policy/platform request helper. Allow supported local/blob/data assets; reject external URLs in standalone. |
| Core remote autorouter | [`Group.ts:857`](https://github.com/tscircuit/core/blob/6a195d6500033025331a1cc5533284866bb69819/lib/components/primitive-components/Group/Group.ts#L857) also uses global fetch. [`CapacityMeshAutorouter.ts:92`](https://github.com/tscircuit/core/blob/6a195d6500033025331a1cc5533284866bb69819/lib/utils/autorouting/CapacityMeshAutorouter.ts#L92) selects networked Pipeline9 when `useCloudAutorouter` is true. | Keep local routing enabled with `useCloudAutorouter:false` and `allowLegacyAutorouters:false`; reject authored remote autorouter config before dispatch. |
| Model/image assets | [`resolve-assembly-model.ts:12`](https://github.com/tscircuit/core/blob/6a195d6500033025331a1cc5533284866bb69819/lib/components/primitive-components/resolve-assembly-model.ts#L12) resolves named assembly models to modelcdn GLB. [`SchematicGraphic.ts`](https://github.com/tscircuit/core/blob/6a195d6500033025331a1cc5533284866bb69819/lib/components/primitive-components/SchematicGraphic.ts#L35) passes asset URLs to `@tscircuit/image-utils`; CAD viewers/exporters consume external model URLs from Circuit JSON. | Catalogue entries must use procedural footprinter CAD and contain no external model URL. Audit external dependencies; reject unsupported external assets or permit only bundled/local assets. Apply browser CSP as a second layer for script/image/model loads outside fetch hooks. |
| Automatic telemetry | [`posthog.ts:152`](https://github.com/tscircuit/runframe/blob/5655ad20182173230998002710dbab989e5bdde9/lib/utils/posthog.ts#L152) initializes at module import. Its localhost exception explicitly tracks CLI (`TSCIRCUIT_USE_RUNFRAME_FOR_CLI`). Activity/error hooks call PostHog. | Initialize analytics lazily and honor an explicit telemetry setting before activity/error capture. Disabling fetch after initialization is too late. |
| UI remote actions | [`CrispFeedbackButton.tsx`](https://github.com/tscircuit/runframe/blob/5655ad20182173230998002710dbab989e5bdde9/lib/components/CircuitJsonPreview/CrispFeedbackButton.tsx#L46) injects a remote script after click and is shown for CLI. Component import dialogs call JLC/KiCad/registry APIs. [`load-easyeda-browser.ts`](https://github.com/tscircuit/runframe/blob/5655ad20182173230998002710dbab989e5bdde9/lib/optional-features/importing/load-easyeda-browser.ts#L33) imports EasyEDA from jsDelivr. | Inject local request-producing services and feedback/reporting callbacks. Preserve user hyperlinks; automatic service/CDN requests need local providers. Supply pinned worker/version metadata and disable remote version selection for standalone. |
| Optional exports | [`export-step.ts:13`](https://github.com/tscircuit/runframe/blob/5655ad20182173230998002710dbab989e5bdde9/lib/optional-features/exporting/formats/export-step.ts#L13) and [`export-glb.ts`](https://github.com/tscircuit/runframe/blob/5655ad20182173230998002710dbab989e5bdde9/lib/optional-features/exporting/formats/export-glb.ts#L15) use `@tscircuit/internal-dynamic-import`, which needs a separate dependency audit. STEP includes external meshes. | Provide an authoritative lazy module manifest with embedded converters and local assets/providers. Qualify each enabled export; including the converter alone is insufficient. |
| CLI defaults | [`get-platform-config-with-cli-defaults.ts:61`](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/lib/shared/get-platform-config-with-cli-defaults.ts#L61) sets `checkAvailability:true` and installs default providers. | Select standalone platform at command construction and force its network controls after normal defaults. Keep the local cache. |
| CLI dev bundle fallback | [`createHttpServer.ts:239`](https://github.com/tscircuit/cli/blob/60256bbff0ab38b761e2cea8c6419ce073c528c5/lib/server/createHttpServer.ts#L239) can redirect missing explicit RunFrame bundle to jsDelivr. | Use embedded RunFrame/worker exclusively and return local actionable errors on missing assets. Local dev HTTP traffic may remain on the application's loopback origin. |

The inspected RunFrame snapshot's [`use-styles.ts`](https://github.com/tscircuit/runframe/blob/5655ad20182173230998002710dbab989e5bdde9/lib/hooks/use-styles.ts) injects generated CSS locally; a legacy Tailwind CDN hook exists but is not evidence that the ordinary RunFrame path calls it. Do not characterize every literal URL in source as an automatic request.

## Initial standalone configuration

Use a fresh platform factory with a catalogue-backed `partsEngine`, `footprintLibraryMap.jlcpcb`, and strict missing-part errors. Set `checkAvailability:false`, `useCloudAutorouter:false`, `allowLegacyAutorouters:false`, and `analogSimulationDisabled:true` until local engine packaging is verified. Keep parts-engine processing enabled so bundled components, supplier selection and footprint generation work; `partsEngineDisabled:true` would disable those supported features. Override or remove default KiCad URL resolvers rather than leaving remote defaults behind. Use a denying `platformFetch` as an additional guard, while documenting that upstream global-fetch/model-import gaps still remain.

RunFrame's [`get-run-frame-project-config.ts`](https://github.com/tscircuit/runframe/blob/5655ad20182173230998002710dbab989e5bdde9/lib/components/RunFrame/get-run-frame-project-config.ts) enables part-orientation analysis. A local catalogue-backed fetchPartCircuitJson can support it. Otherwise disable it explicitly rather than letting a parts-engine request discover missing remote data during rendering.

## Remaining integration sequence

1. Expand the compact catalog with deterministic admission metrics and source
   notices; unknown parts remain local errors.
2. Generalize provider-default selection and request/import boundaries in
   props/eval/core while preserving ordinary online defaults. Keep project
   configuration from restoring unsupported network providers.
3. Qualify the normal RunFrame browser worker, platform-backed viewers, real
   bundled converter manifests, and all required WASM/font/model assets. Fresh
   browser/storage and worker-level request recording are required.
4. Expose reusable upstream CLI composition for local catalog imports and
   embedded build/dev workers. Existing network import/acquisition commands
   need their own resolver integration.
5. Execute compiled binaries natively on every advertised target and finish
   checksums, version/capability metadata, notices, and redistribution review.

## Acceptance tests for upstream work

- Unit/integration: known catalogue chip → footprinter → Circuit JSON with correct pins/pads and supplier metadata; unknown supplier/part/request rejects deterministically; no network fallback; explicit authored remote footprints/autorouters reject before dispatch.
- Config precedence: standalone cannot be disabled by project platform config, cloud autorouter flags, a replacement parts engine, registry import or lazy simulation engine. Ordinary placement/layout/DRC settings continue to work.
- Worker: execute a local imported chip in the embedded worker using the actual standalone platform; Comlink config roundtrip and normal source execution work; no remote version lookup, CDN worker download, npm resolution, registry request or analytics initialization. Fresh browser/storage matters because caches can conceal downloads.
- UI: start real `dev` on loopback; Playwright records all browser/worker traffic and fails for nonlocal requests; open PCB, schematic, generated 3D, errors/BOM and every enabled export/import control. Preserve ordinary hyperlink navigation; missing requested application content gives a useful local error. Test CSP violations and attempted forbidden requests as failures, rather than passing because requests were blocked.
- Native: run the compiled executable in a clean directory with no `node_modules`, Bun/Node installation, cached parts/assets or internet access. `--help`, `--version`, catalogue search/import, minimal circuit build and supported exports pass. Track outbound connection attempts independently of fetch stubs; exercise failure paths too.
- Assets: inspect final build graph for external dynamic imports, scripts/fonts/WASM/models; compare enabled feature inventory with bundled assets. Build-time network access is permitted; automatic runtime requests need only the bound loopback origin; explicit user navigation is separate.

Application-level request policy alone is not a security sandbox for arbitrary user-authored TypeScript that imports networking APIs directly. If the distribution promises containment of arbitrary code, that requires a separate process/browser sandbox policy and OS-level validation. The initial product guarantee should concern its built-in commands, bundled components and supported rendering flows.
