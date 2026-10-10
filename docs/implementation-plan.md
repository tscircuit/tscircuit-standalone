# Standalone implementation plan

## Goal and runtime contract

Release `tscircuit standalone` as downloadable compiled executables with a
custom platform and a compact catalog. Supported standalone commands and
automatic user-facing UI operations must work without outbound requests or
runtime package downloads.
Missing parts, dependencies, and assets fail locally. Build-time acquisition
and dependency installation may use the network. Dev communicates with its
bound loopback origin; user navigation through external hyperlinks is allowed.

Developer-only features such as the Solvers debugger are outside the supported
standalone user workflows and network qualification. Their CDN loading may
remain unchanged; no local CDN replacement is required for those tools.

`tsci import C2040` creates an RP2040 component from a verified footprinter
string and pin mapping. Popularity alone does not qualify a part: only compact,
accurately reproducible footprints enter the catalog. Expanded geometry blobs
and remote CAD assets are omitted.

## Current foundation

- Repository provisioned through `tscircuit/create-repo` PR #91.
- Footprinter-only catalog validation, deterministic generated components,
  source/license provenance, local lookup, and local missing-part errors.
- One admitted part: RP2040/C2040 from a pinned MIT-licensed `tscircuit/common`
  source. Its 57 pads and pin mapping match the reference; copper IoU is 99.8179%.
- Custom platform using existing `PlatformConfig`/`PartsEngine` APIs, local
  supplier-footprint resolution, and rejecting request/provider defaults.
- Native `tsci import`, `catalog`, and `build`. Builds use a fresh embedded
  worker and local routing, producing Circuit JSON, PCB/schematic SVG, and a
  diagnostic report. DRC errors retain inspectable artifacts and return exit 1.
- A bounded static source graph: 100 files/2 MiB, an exact embedded module
  allowlist, project/symlink boundaries, and local source imports. Dynamic user
  imports, top-level await, CommonJS require, project configuration imports,
  unbundled modules, and project node_modules reads are rejected.
- Native regression circuits, preview artifacts, thermal-ground connectivity,
  and schematic rail-label checks. See [circuit inspection](circuit-inspection.md).
- `tsci dev` now prepares source `fsMap` and serves bundled assets. Ordinary
  RunFrame evaluates that source in its local browser worker with pinned eval
  0.0.1569, Comlink, the catalog platform, and shared circuit/request validation.
- RunFrame is composed through public `@tscircuit/runframe/runner` exports,
  shared `@tscircuit/props` `PlatformConfig`, the existing worker/version props,
  and autorouting-report callback. `host-config.js` executes before app imports
  and sets the existing telemetry/version globals. The canvas backend uses the
  existing viewer storage convention, defaulting fresh profiles to canvas
  while retaining saved preferences; CDN loading is disabled inside the worker.
- Bundled dynamic-import manifests cover Altium, the ten RunFrame converter
  package names, and schematic placement analysis 0.0.46. Manifold/fonts and
  exporter WASM adapters are local. The existing parts-engine availability
  provider returns unknown stock; the schematic viewer generates SVG thumbnails
  locally and loads style analysis through the generic importer. Telemetry uses
  the startup host setting; hyperlinks
  retain normal navigation behavior.
- The user merged reusable composition and lifecycle changes:
  [RunFrame #5618](https://github.com/tscircuit/runframe/pull/5618),
  [RunFrame #5643](https://github.com/tscircuit/runframe/pull/5643),
  [schematic-viewer #285](https://github.com/tscircuit/schematic-viewer/pull/285),
  [schematic-viewer #287](https://github.com/tscircuit/schematic-viewer/pull/287),
  [internal-dynamic-import #35](https://github.com/tscircuit/internal-dynamic-import/pull/35),
  [RunFrame worker lifecycle #5632](https://github.com/tscircuit/runframe/pull/5632),
  and [RunFrame static JSON #5637](https://github.com/tscircuit/runframe/pull/5637).
  Never merge PRs automatically.
- Standalone uses published packages and
  public entrypoints: RunFrame 0.0.2953, importer 0.0.17, and schematic-viewer
  2.0.104. The published RunFrame artifact includes the merged changes; exact
  versions are recorded in the dependency manifest and lockfile.
  No composite RunFrame branch is needed. Fresh compiled-browser and native
  qualification has passed with these dependencies and host settings.
- PR scope follows package ownership: RunFrame owns viewer forwarding and
  existing host-configuration conventions; worker lifecycle and static JSON
  have separate PRs. Schematic-viewer owns platform-based
  availability and local thumbnails; internal-dynamic-import owns generic
  module resolution. Standalone owns providers, manifests, packaging, and
  qualification. Shared `@tscircuit/props` interfaces stay unchanged.
- Builds generate backend/frontend/worker input graphs, copied-asset notices,
  and dependency inventory. Full license review remains required for Bun's
  linked native libraries, WASM internals, missing notices, and applicable LGPL
  redistribution obligations.

[Earlier foundation CI](https://github.com/tscircuit/tscircuit-standalone/actions/runs/37892852019)
qualified initial native import/build paths, socket tracing, network-namespace
execution, and compilation for five targets. Native execution was Linux x64.
The published-package browser-worker integration passed fresh local compiled
Linux x64 qualification: all six views, source/cached JSON, edit/watch/import
recovery, twelve module namespaces, and thirteen operations produced no
external request attempts or CSP violations. The proof recorded 31 same-origin
resources and two worker URLs, with no browser/console errors or local request
failures. Frozen installation with Bun 1.3.12, backend/UI types, 98 tests with
647 assertions, binary build/notices, and native clean-project smoke also passed;
native tracing recorded no external socket, connect, or send attempts.
CI repeats the browser harness in a loopback-only namespace separately from
these local results. No official release has been published.

The native CLI build path remains unchanged by the RunFrame composition work.
Its fixtures are runtime examples rather than complete production designs:
RP2040 omits flash, crystal, USB implementation, and full per-pin decoupling.
Its explicit schematic placement works around an upstream auto-layout issue
that drew a separate ground cluster without a rail label. Retain the existing
rail-label regressions until that general issue is fixed.

## Remaining work

### 1. Expand the compact catalog

Keep records limited to supplier/MPN identity, export name, footprinter recipe,
complete pin labels/attributes, searchable metadata, and qualification
provenance. Generate expanded footprints and TSX at runtime. Acquisition is a
build-time process, separate from runtime lookup.

Seed candidates from curated `common` components and popular-category `jlc100`
lists. `jlc5000` can supply additional candidates, but its stock ranking is not
usage popularity. For each candidate, require copper IoU >98%, equal pad count,
complete physical pin mapping, and no conflicting physical-pin aliases. Record
rejections instead of admitting exact geometry. Preserve source licenses.

Generate a deterministic admission manifest with source commits, converter and
footprinter versions, ranking, metrics, serialized size, and a catalog size
budget. Add footprint/render/thermal-pad checks before expanding the catalog.
Bundle other request responses only when their API shape and compact local
representation are verified. Do not emulate raw EasyEDA acquisition payloads.

### 2. Generalize runtime providers and policy

Keep the host-owned source allowlist and request/asset policy when composing
ordinary eval/core. Create catalog adapters inside each worker; Comlink should
transport plain provider results, not native Response objects. Preserve
placement/layout/DRC options while rejecting project changes that restore
cloud routing, unknown suppliers, package installation, or remote assets.

Upstream eval still needs reusable provider-default selection and consistent
request/import boundaries. `disableCdnLoading` alone does not cover registry
imports, default KiCad fetchers, or lazy simulation fallbacks. Generic local
providers and explicit request resolvers should retain normal online defaults
for other applications. Compose RunFrame through those provider and resolver
hooks.

Core's global-fetch footprint/autorouter paths and named model/image loaders
must honor the same policy. Keep procedural footprinter CAD and local routing.
Enable simulation only after its engine/WASM and failure paths are packaged and
qualified; current analog execution remains unavailable.

### 3. Qualify normal RunFrame and bundled exporters

RunFrame receives `fsMap`, the explicit worker URL/version, and the custom
platform. Its normal CircuitRunner/Comlink protocol executes in the browser;
the dev server does not render circuits or serve resulting JSON. A JSON entry
uses RunFrame's existing file-viewing branch after array/element and asset
validation. Part identity metadata can remain unknown in that branch because
already-rendered geometry causes no catalog lookup. Source evaluation retains
full part/provider/asset/effect validation. Host source-graph failures remain in
the editor build-error panel while RunFrame stays mounted with a hidden preview;
worker failures use its ordinary Errors view. Supply an empty `fsMap` when the
host has no valid source graph, without adding error or controlled-JSON props.

Install dependency resolvers before consumers execute, separately in each
JavaScript realm that needs them. The standalone manifest rejects unknown
packages and exact-version misses without a CDN fallback; web consumers may
use the package's normal resolver or selectively delegate. Keep actual
converter implementations rather than blanket optional-feature stubs.

The app provides JSON/PCB SVG/schematic SVG downloads. Bundled KiCad, GLB, STEP,
LBRN, fabrication, and FDM converters still require per-format output tests and
complete local asset/provider coverage before their controls are advertised.
The KiCad smoke check currently verifies document formats, not symbol/layout
fidelity; add semantic artifact checks before exposing these exports.
KiCad library/model acquisition, inferred built-in model URLs, EasyEDA loading,
converter-specific WASM fallbacks need explicit local implementations and useful
local errors. Compound GLTF/GLB/SVG assets now receive bounded nested-resource
validation; WRL/3MF and unbundled decoders are explicit local misses. Measure
browser/binary size as capabilities grow.

Viewer stock is unknown (`undefined`) through the existing
`partsEngine.fetchPartAvailability` provider. The viewer generates SVG
thumbnails locally; the generic importer resolves the local 0.0.46 analyzer.
Preserve ordinary supplier links and the existing report callback's user
navigation. Before app imports, `host-config.js` sets
`window.TSCIRCUIT_TELEMETRY_DISABLED = true` and
`window.TSCIRCUIT_ALLOW_SELECTING_EVAL_VERSION = false`; it stores
`JSON.stringify("canvas")` under `pcb_viewer_rendering_engine` only when the key
is absent, preserving existing preferences. Keep
`runner.setDisableCdnLoading(true)` inside the worker.
The shared `PlatformConfig` carries circuit providers through the existing prop.

Qualify the actual compiled app from fresh browser/storage and a clean project.
Exercise its local worker, all enabled views, editor saves/watches, catalog
imports, downloads, and failure recovery. Record worker CSP/security logs as
well as page requests; a blocked automatic request is still a failure. The CI
network namespace permits only loopback. Refresh browser evidence after final
pins and asset generation. Browser execution currently has no deadline, so
an accidental infinite loop can require a page reload. Add a generic RunFrame
execution-timeout API; dev has no `--timeout-ms` option. Native build retains
its existing deadline. See [bundled RunFrame](offline-runframe.md).

### 4. Reusable CLI composition

The current repository composes a narrow native import/catalog/build CLI and a
source-serving dev command. Expose reusable upstream CLI construction with an
injected platform factory, local component resolver, module resolver, worker
entries, and UI assets. Existing CLI import bypasses platform config and fetches
JLC/EasyEDA/datasheets directly, so intercept known catalog requests before that
pipeline. Avoid eagerly registering auth/publishing/update commands.

Preserve embedded dependencies, disabled Bun auto-install, local cache, and
local missing-module errors. Any added worker/export command needs its own
bundled entry and providers; dependency inclusion alone is insufficient.

### 5. Release qualification and distribution

Build from exact dependency and catalog pins. Produce Linux x64/arm64, macOS
x64/arm64, and Windows x64 artifacts, then execute native smoke tests on each
advertised target. Cross-compilation is preparation rather than native support.
Check OS/libc and CPU requirements, worker loading, WASM/native libraries, empty
caches, clean projects, and missing-runtime failure paths.

Generate checksums, version/catalog metadata, capability and size reports, and
complete redistribution notices. Resolve native/WASM license requirements and
sign/notarize artifacts where applicable. Publish through an explicit manual or
tag release workflow after acceptance gates pass. No release or merge should
happen automatically as part of this preparation work.

## Release acceptance gates

| Gate | Required evidence |
| --- | --- |
| Compact catalog | Deterministic records; qualified pads/pins; local unknown-part errors; provenance and notices for every admitted part. |
| Runtime dependencies | Clean project and empty caches, without project node_modules or Bun/Node/npm on PATH; every advertised command/export succeeds. |
| Automatic requests | Native connection tracing plus browser/worker request recording, including success, misses, errors, and enabled UI actions; no outbound automatic requests. |
| Configuration | Project code/config cannot restore remote providers, CDN/registry imports, telemetry, cloud routing, or auto-install for supported flows. |
| RunFrame | Ordinary source execution through the bundled browser worker/version/platform; required views, services, imports, and exports work at the bound loopback origin. |
| Portability | Native smoke on every advertised OS/architecture, including worker/WASM/native asset paths. |
| Artifacts | Checksums, exact dependency/catalog metadata, licenses/notices, measured size, and documented feature limits. |

These application guards cover supported commands and rendering flows.
Containment of arbitrary adversarial TypeScript requires a separate process/OS
sandbox; it is not established by the current source allowlist or fetch hooks.

## Source evidence

[Runtime audit](runtime-audit.md) and [CLI audit](cli-audit.md) preserve the
original inspected upstream snapshots. The merged changes and current
composition address selected findings; they do not mean the general
upstream CLI is already offline or that all exporters have been qualified.
