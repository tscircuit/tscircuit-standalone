# Standalone implementation plan

## Goal and runtime contract

Release `tscircuit standalone` as downloadable compiled executables, using a
custom platform configuration and a small embedded catalog. Supported commands
must make no outbound web requests, including when a part, dependency, asset,
or feature is unavailable. Missing data fails locally with a useful error.
Release-time catalog acquisition and dependency installation may use the network.

`tsci import C2040` is the initial working example. It creates an RP2040 component
from an embedded footprinter string and its pin mapping. Popularity alone is
insufficient for admission: only accurately reproducible compact footprints
qualify. Exact geometry blobs and remote CAD models are omitted.

For `dev`, HTTP/WebSocket traffic to the application's bound loopback origin is
required; that is local communication. External network destinations remain
unavailable. Arbitrary user TypeScript can directly invoke networking APIs, so
containment of arbitrary code needs a separate process/OS sandbox. The release
contract must state the supported commands and project features it covers.

## Current milestone

- Public repository provisioned through `tscircuit/create-repo` PR #91, with
  maintainers/staff access.
- Footprinter-only catalog schema, source provenance, deterministic component
  generation, pad/pin validation, local lookup, and missing-part errors.
- RP2040/C2040 seed, pinned to an MIT-licensed `tscircuit/common` source. All 57
  pads match the exact reference; copper IoU is 99.8179%.
- Custom platform factory using existing `PlatformConfig`/`PartsEngine` APIs.
  Local footprint lookup, disabled online services, and fail-closed request
  resolution. No new chip-specific API is needed in core.
- `tsci import`/`catalog` and `tsci build <entry>` commands. Builds evaluate a
  bounded local source graph in a fresh embedded worker, route locally, and
  write Circuit JSON, PCB/schematic SVG, and a diagnostic report. The CLI accepts
  `--output-dir`, `--project-dir`, and `--timeout-ms`.
- Pinned eval/core/renderers and explicit runtime dependencies, checked against
  a fresh frozen install. A compiled-binary smoke builds the three examples and
  a `src/` circuit importing freshly generated `imports/C2040.tsx`, in a clean
  project without project `node_modules` or Bun/Node on PATH.
- Loader guards for reachable static source imports, an exact embedded module
  allowlist, project/symlink boundaries, and limits of 100 files/2 MiB. Dynamic
  imports, top-level await, CommonJS `require`, project configuration imports, and
  unbundled modules are rejected.
- Worker-owned offline platform, rejecting eval provider defaults, captured
  request/effect failures, and checks for remote assets, cloud routing, custom
  parts engines, and unknown supplier/MPN declarations.
- Circuit regressions with populated schematics: LED/resistor (6 pads, 3 routes),
  RP2040 (72 total pads, 26 routes, 8 vias), and direct `jlcpcb:C2040`
  resolution (59 pads, 2 routes, 2 vias). All have no Circuit JSON error diagnostics. The RP2040
  test verifies all 57 U1 pads and routed 3.1 mm thermal-ground connectivity.
- Generated PCB/schematic PNG/SVG previews, Circuit JSON, reports, and a
  self-contained inspection gallery are checked in as review evidence, outside
  the embedded compact runtime catalog. Schematic geometry regression checks
  seven capacitor/testpoint paths against their intended rail labels.
- DRC errors such as PCB footprint overlap return exit code 1 while preserving
  inspectable build artifacts. Unsupported offline requests fail before new
  artifacts are published.
- `tsci dev` serves an embedded RunFrame application on loopback. It uses the
  existing offline host evaluator and controlled Circuit JSON, with entry
  editing, revision-safe saves, dependency watches, embedded catalog imports,
  local downloads, and PCB/schematic/procedural CAD/BOM/error/JSON views.
- Bundled Manifold JS/WASM and a local Troika font, isolated browser React,
  offline RunFrame/schematic controls, and browser/worker request monitoring.
  The reviewed upstream changes remain open PRs with exact commit pins; see
  [offline RunFrame](offline-runframe.md).
- Builds generate a compiler metafile and package notice inventory: currently
  240 package roots, with 73 follow-up flags. Full license certification,
  including native Bun/WASM dependencies and applicable LGPL obligations,
  remains a release gate.
- [CI qualification](https://github.com/tscircuit/tscircuit-standalone/actions/runs/37892852019)
  passed all 63 tests, native socket tracing with zero network attempts on the
  exercised import/build success and failure paths, network-namespace builds,
  and all five cross-compilation targets. Native execution has been checked on
  Linux x64 only.

This remains preparation for an official release. Wider RunFrame capabilities, simulation,
additional exports, catalog growth, and native qualification for the remaining
targets are pending. The circuits retain documented warnings and are runtime
fixtures; the RP2040 example omits flash, crystal, USB implementation, and full
per-pin decoupling. See [circuit inspection](circuit-inspection.md) for measured
results and limitations. Worker guards cover supported evaluator paths, rather
than providing an OS sandbox for arbitrary adversarial TypeScript.

The standalone path addresses blank schematic previews through explicit sheet
membership, embeds the compiled worker, assigns unique virtual IDs to avoid
eval relative-import cache collisions, surfaces swallowed async errors, and
overrides online provider defaults. Source regressions also cover runtime
extension substitution, MTS/CTS/MJS/CJS source formats, and Unicode import
bindings that eval's own preload scanner misses. These repository adaptations
do not mean the general upstream CLI or RunFrame is offline. The source audits
below pin the inspected upstream commits and identify the remaining integration work.

The RP2040 fixture uses explicit relative schematic placement to work around
an upstream auto-layout issue: the source netlist correctly connected C1/C2 to
GND, but automatic layout drew their separate wire cluster without a GND label.
`schDisplayLabel` did not restore it, and an authored netlabel was anchored at
the component's pre-layout position. The manual fixture and seven label-path
regressions qualify this example; they do not fix general core auto-layout.

## Work sequence

### 1. Compact catalog and acquisition pipeline — standalone repository

Keep records limited to supplier/MPN identity, export name, a footprinter recipe,
complete pin mapping/attributes, searchable metadata, and source/qualification
provenance. Generate footprints and TSX when needed rather than storing expanded
Circuit JSON or raw EasyEDA payloads. Separate build-time acquisition from
runtime lookup.

Seed candidate selection from curated `common` components, then the popular
category lists in `jlc100`. Consider stock-ranked `jlc5000` as an additional
candidate source; its stock ranking is not usage popularity. Qualify every
candidate with the existing CLI converter: copper IoU >98%, equal pad count,
complete physical pin mapping, and no conflicting remapped aliases. Record
rejections rather than falling back to exact geometry. Preserve license notices.

Generate a deterministic catalog manifest with source commits, converter and
footprinter versions, admission metrics, candidate ranking, serialized size,
and overall size budget. Report admitted/rejected counts. Add rendering/thermal
pad regressions before growing the catalog. Add local search and common request
aliases only for verified response shapes; do not carry the EasyEDA acquisition
API into the runtime to make imports work.

### 2. Generalize the offline runtime policy — props, eval, core

The current standalone worker selects the platform before evaluator loading,
disables CDN resolution, supplies rejecting KiCad/simulation providers, and
captures offline misses. Its loader accepts only explicit embedded modules and
local static source files. Keep these protections and regressions while moving
the policy into reusable upstream interfaces.

Define an explicit host-owned offline profile alongside `PlatformConfig`, with
local module/asset/import resolution and an offline miss contract. Ensure the
policy survives project configuration overrides and normal CLI/eval defaults.
Keep ordinary placement/layout/DRC options configurable.

In eval, add provider-default selection so callers do not need to replace every
online provider with a rejecting implementation. Gate `@tsci/*` registry
imports as well as CDN module loading; `disableCdnLoading` alone is insufficient
outside the standalone loader's exact allowlist.
Eliminate simulation CDN fallback, initially disabling simulation until its
engine/WASM can be embedded and tested. Require an embedded worker in offline
mode. Instantiate the catalog adapter in each worker and pass serializable
profile/catalog identifiers; do not assume native `Response` objects transfer
through Comlink.

In core, route remote footprint and authored remote autorouter paths through the
shared request policy. Force local routing. Resolve only embedded/local assets;
reject unsupported remote models, images, named assembly assets and dependencies
before dispatch. Retain procedural footprinter CAD. Test failure paths and
project attempts to restore online providers.

### 3. Public CLI composition and wider binary integration — cli, standalone

The repository already composes a narrow import/catalog/build CLI and embeds
the build worker, React/eval/core, local router, and SVG converters. Extend this
working path deliberately; do not reintroduce dynamic dependency downloads or
filesystem worker assumptions when adding commands.

Expose a configurable CLI factory or public command registration interface with
injected platform factory, component import resolver, module resolver, worker
entrypoints, UI assets, and enabled command capabilities. Avoid importing the
legacy `cli/main.ts`, which eagerly registers online commands and parses argv.
Connect the upstream CLI's `import` to the local catalog before search/conversion;
that command currently bypasses runtime platform config and fetches
JLC/EasyEDA/datasheets directly.

Preserve embedded React/tscircuit dependencies, disabled Bun auto-install, and
local errors for missing modules. Expand the module allowlist only when the
new dependency and its assets are bundled and tested. Load the profile inside
any added snapshot/export workers and give each an explicit embedded entry.

Circuit JSON builds, local routing, and schematic/PCB SVG output are now enabled.
Next qualify any additional exports with fully bundled converters. Keep auth,
cloud publishing, ordering, update/install and unqualified dynamic exports
unavailable. Measure binary size after each feature addition.

### 4. Offline RunFrame and local dev — runframe, eval, cli

Resolve the upstream schematic auto-layout label/anchor issue above and retain
geometric rail-label regressions before relying on automatic layouts in RunFrame.

The standalone dev path now embeds a pinned RunFrame source bundle, CSS, favicon,
and required assets. It renders in the existing fresh host worker and passes
controlled Circuit JSON/loading/errors to RunFrame. Controlled/static modes
skip eval-version lookup and browser evaluator startup entirely. Browser worker
creation is unavailable in this build. Upstream RunFrame and schematic-viewer
changes remain open for review; qualify published versions before replacing
their exact GitHub commit pins.

RunFrame's offline capabilities suppress PostHog, support/Crisp, cloud/file and
eval-version controls, remote reporting and supplier links. Local catalog
search/import and JSON/SVG downloads are supplied by the host. Schematic
tooltips skip stock and remote footprint services, and style analysis is
disabled. Manifold and Troika initialize from embedded JS/WASM/font assets before
the viewer mounts. All imports use one isolated browser React instance.

The loopback server validates host/origin, fixes the source/catalog API surface,
retains project/symlink boundaries and source revision conflicts, and rejects
missing assets locally. Its CSP limits connections to the bound origin. A
compiled-browser harness covers real preview/edit/import/download success and
failure paths and records dedicated-worker CSP errors as attempted requests.
CI executes it in a network namespace with only loopback enabled.

Next move the host's optional-feature bundler replacements and source-alias
handling into explicit upstream injection points, qualify additional views and
exporters, and trim the browser bundle. If browser-side evaluation is added,
require an embedded version/worker and recreate it when the profile changes.
Keep simulation execution disabled until its engine/WASM is bundled and tested.

### 5. Release qualification — standalone repository

Build reproducibly from pinned versions and the qualified catalog. Produce
Linux x64/arm64, macOS x64/arm64, and Windows x64 artifacts. Cross-compilation is
preparation; execute native smoke tests on each target before announcing support.
Verify OS/libc baselines, CPU requirements, WASM/native modules and worker paths.
Retain the passing Linux socket-trace and network-namespace CI checks and extend
them for each new capability. Local worker tests and an invalid proxy setting
do not by themselves prove the absence of native network attempts.

Generate SHA-256 checksums, dependency/license inventory, embedded version/catalog
metadata, feature list, and artifact size reports. Add signed/macOS-notarized
releases as applicable. Use an explicit tag/manual release workflow only after
all capability checks pass. Decide product artifact naming while preserving
the `tsci` invocation users expect.

## Release acceptance gates

| Gate | Required evidence |
| --- | --- |
| Compact catalog | Known parts reproduce pads/pins; unknown parts fail; deterministic manifest; every admitted footprint qualifies and has provenance/license. |
| No runtime downloads | Clean project, empty caches, no node_modules, no Bun/Node/npm on PATH; import, build, routing and every enabled export succeed. |
| No outbound attempts | OS network-denied CLI harness plus browser/worker request recording; exercise successful paths, missing parts/modules/assets, errors and UI actions. Observe attempted connections, not only successful requests. |
| Configuration invariants | Project config cannot restore remote providers, cloud routing, registry imports, telemetry or package installation. |
| RunFrame | Fresh browser/storage; embedded host evaluator and viewer assets; schematic, PCB, procedural 3D and all enabled controls work using only the bound loopback origin. |
| Binary portability | Native smoke on each advertised OS/architecture; no hidden filesystem worker or dynamic module dependencies. |
| Release artifacts | Checksums, version/catalog manifest, notices, size/features inventory and documented unsupported features. |

Recommended initial release scope: qualified catalog import, local circuit JSON
build/routing, schematic and PCB views, and only verified offline exports. Add
simulation and complex CAD exports after their engines/assets pass the same gates.

## Source evidence

See [runtime audit](runtime-audit.md) for exact PlatformConfig, eval, core and
RunFrame gaps; [CLI audit](cli-audit.md) for import interception, packaging,
catalog sources and RP2040 qualification. These audits pin the inspected source
commits and do not claim upstream changes have already been made.
