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

## Current preparation

- Public repository provisioned through `tscircuit/create-repo` PR #91, with
  maintainers/staff access.
- Footprinter-only catalog schema, source provenance, deterministic component
  generation, pad/pin validation, local lookup, and missing-part errors.
- RP2040/C2040 seed, pinned to an MIT-licensed `tscircuit/common` source. All 57
  pads match the exact reference; copper IoU is 99.8179%.
- Custom platform factory using existing `PlatformConfig`/`PartsEngine` APIs.
  Local footprint lookup, disabled online services, and fail-closed request
  resolution. No new chip-specific API is needed in core.
- Scoped `tsci import`/`catalog` commands, compiled binary build, frozen
  dependencies, tests, clean-directory binary smoke, and CI cross-build targets.

This is a foundation, not a full offline release. Rendering, dev/RunFrame, and
exports are unavailable in the preparation CLI. The runtime audits record
specific upstream files and commit permalinks, rather than assuming a platform
fetch hook intercepts every request.

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

### 2. Offline runtime policy — props, eval, core

Define an explicit host-owned offline profile alongside `PlatformConfig`, with
local module/asset/import resolution and an offline miss contract. Ensure the
policy survives project configuration overrides and normal CLI/eval defaults.
Keep ordinary placement/layout/DRC options configurable.

In eval, add provider-default selection so a custom offline platform does not
silently regain JLC/KiCad/ngspice network providers. Gate `@tsci/*` registry
imports as well as CDN module loading; `disableCdnLoading` alone is insufficient.
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

### 3. Public CLI composition and binary integration — cli, standalone

Expose a configurable CLI factory or public command registration interface with
injected platform factory, component import resolver, module resolver, worker
entrypoints, UI assets, and enabled command capabilities. Avoid importing the
legacy `cli/main.ts`, which eagerly registers online commands and parses argv.
Connect `import` to the local catalog before search/conversion; it currently
bypasses runtime platform config and fetches JLC/EasyEDA/datasheets directly.

Provide embedded React/tscircuit and supported dependencies to the evaluator.
Disable Bun auto-install; reject missing modules instead of dynamically importing
unresolved packages. Reload the standalone profile inside build/snapshot workers
and replace sibling-file path assumptions with explicit embedded entries.

First enable circuit JSON builds, local routing, schematic/PCB output, and
exports whose converters are fully bundled. Keep auth, cloud publishing,
ordering, update/install and unqualified dynamic exports unavailable. Measure
binary size after each feature addition.

### 4. Offline RunFrame and local dev — runframe, eval, cli

Embed a pinned RunFrame bundle, eval worker/version, CSS, favicon and required
assets. Skip eval-version lookup when using embedded workers; current RunFrame
still resolves versions before loading that worker. Forward the offline profile
and pinned version through `RunFrameForCli` and every wrapper. Recreate workers
when policy changes; do not reuse a globally cached online worker.

Remove or disable PostHog before its import-time initialization. Supply local
catalog search/import controls. Omit remote-only support/Crisp, login, cloud,
registry and eval-version controls. Audit every optional exporter and 3D/image
loader; bundle enabled code/WASM assets with static resolution. Hide unavailable
capabilities with clear product-facing labels.

CLI dev must load the runtime profile, serve embedded UI/worker assets locally,
remove Tailwind CDN/favicon requests, and fail locally on missing bundles rather
than redirecting to jsDelivr. Apply a same-origin CSP permitting only required
local/blob/data resources. Test real browser and worker request attempts; CSP
blocking an attempted request is still a test failure.

### 5. Release qualification — standalone repository

Build reproducibly from pinned versions and the qualified catalog. Produce
Linux x64/arm64, macOS x64/arm64, and Windows x64 artifacts. Cross-compilation is
preparation; execute native smoke tests on each target before announcing support.
Verify OS/libc baselines, CPU requirements, WASM/native modules and worker paths.

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
| RunFrame | Fresh browser/storage; embedded worker/version/assets; schematic, PCB, procedural 3D and all enabled controls work using only the bound loopback origin. |
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
