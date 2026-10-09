# Bundled RunFrame and local dev

`tsci dev <entry>` serves RunFrame, the evaluator worker, source files, and
runtime assets at a bound `http://127.0.0.1:<port>` origin. RunFrame executes the
source through its normal browser-worker protocol. The server prepares the
bounded local source graph and transfers it as `fsMap`; it does not evaluate
the circuit or serve rendered Circuit JSON. Dependency installation happens
when building the binary.

```sh
bun install --frozen-lockfile
bun run build
./dist/tsci dev examples/rp2040-breakout.circuit.tsx --port 3020
```

Open the printed URL for PCB, schematic, procedural 3D, BOM, errors, and Circuit
JSON views. The entry editor saves with revision checks; dependency files can
be edited externally and watched. Rebuild uses saved files. The embedded
catalog imports RP2040/C2040 into `imports/C2040.tsx` without replacing existing
files. Add that local import to the circuit to use it. Syntax errors and
unsupported imports remain editable. `--project-dir` sets the source boundary,
`--port 0` chooses a free loopback port, and Ctrl+C stops the server.

## Worker and dependency composition

The app supplies RunFrame with `fsMap`, `mainComponentPath`, eval version
`0.0.1569`, `/assets/eval-worker.js`, `disableCdnLoading`, and the custom platform.
The local worker exposes a normal `CircuitRunner` through Comlink. Its wrapper
installs the request policy before evaluator initialization, constructs the
catalog platform inside the worker, and validates authored circuits and JSON
snapshots with the same policy used by native CLI builds. Rejected requests and
asynchronous failures become render errors rather than incomplete previews.
Native Response objects are not transported through Comlink.

A Circuit JSON entry uses RunFrame's existing file-viewing branch. The source
loader validates its array/element structure and embedded-asset URLs before
viewing; unknown part identity metadata is allowed because this branch already
contains geometry and makes no part requests. Source evaluation continues to
apply full part, asset, authored-provider, and asynchronous-effect validation.

RunFrame also has a controlled Circuit JSON API for static or host-managed
consumers. Standalone uses the source/worker path. Pinned version metadata and
the supplied worker URL remove the need for eval-version discovery or worker
CDN downloads. Project configuration cannot restore unsupported providers.

The real `@tscircuit/internal-dynamic-import` package receives a lazy manifest
through `setDynamicImportResolver(createDynamicImporter(loaders))`. Literal
imports bundle the ten converter package names currently requested by
RunFrame, plus its statically imported Altium converter, with exact version aliases. A missing package/version rejects locally;
loader errors do not trigger a CDN fallback. Ordinary web consumers retain the
package's default resolver or can delegate selected requests to it. See the
[manifest](../ui/bundled-modules.ts) for the pinned converters.

The build includes local Manifold JavaScript/WASM, OCCT and Resvg WASM adapters,
and a Troika font. Browser UI imports share one React instance; the evaluator
worker has its own consistent dependency graph. Manifold and the font initialize
before viewers mount, and unsupported Unicode uses the local missing-glyph
outline. PCB uses the canvas renderer and does not require a WebGPU adapter.

Bundling converters is preparation for per-format qualification. The current
app exposes Circuit JSON, PCB SVG, and schematic SVG downloads. Simulation,
remote KiCad libraries/models, EasyEDA acquisition, and additional exporter
controls still need qualified local providers or explicit local errors. A
bundled converter can itself request model files or other assets, so its package
being present is insufficient evidence that an export has correct geometry.
Inline GLTF/GLB and SVG payloads are checked for nested resources before viewer
handoff. Self-contained GLTF 2.0/GLB v2 and static SVG references are supported;
remote references, unbundled compression/image decoders, and inline WRL/3MF
fail locally. Parsed inline assets have an 8 MiB decoded limit and bounded
structure/recursion checks.

## Viewer services and request policy

Schematic services are injected through ordinary viewer APIs: supplier stock
and price return `null` (unknown), footprint thumbnails are locally generated
SVG data URLs, and style analysis uses bundled
`@tscircuit/circuit-json-schematic-placement-analysis@0.0.46`. Supplier links
remain normal hyperlinks. `telemetryEnabled={false}` prevents analytics
initialization/capture; a custom feedback action opens the repository issue
page through user navigation.

User navigation to external pages is allowed. Automatic application requests,
CDN imports, telemetry, and remote asset loading cannot rely on escaping the
local request policy. The worker permits only its supported same-origin asset
requests and rejects other transports before dispatch. Unsupported external
footprints, models, images, supplier declarations, and modules fail locally.

The server binds to IPv4 loopback, validates the bound host and mutation origin,
and serves a fixed asset/source/catalog API surface. Imports and symlinks must
stay inside the project; saves use source revisions to preserve external edits.
Its CSP restricts connections and asset/script origins to local resources.
Manifold's generated wrappers and WASM require script evaluation permission.
These supported-flow guards are not an OS sandbox for arbitrary adversarial
TypeScript.

Browser execution currently has no deadline. An accidental infinite authored
loop can require a page reload; a generic RunFrame execution-timeout API is
follow-up work. `--timeout-ms` applies only to native `tsci build`.

## Upstream changes

These PRs remain open and must never be merged automatically:

- [RunFrame #5618](https://github.com/tscircuit/runframe/pull/5618): worker/version
  composition, viewer service forwarding, telemetry and feedback hooks,
  controlled JSON support, and source exports.
- [schematic-viewer #285](https://github.com/tscircuit/schematic-viewer/pull/285):
  injectable availability, footprint-preview, and style-analysis services,
  retaining ordinary controls and links, plus source exports.
- [internal-dynamic-import #35](https://github.com/tscircuit/internal-dynamic-import/pull/35):
  configurable resolvers, typed lazy manifests, exact-version matching, and
  source exports.

The UI uses exact GitHub commit pins while those changes are under review.
Replace them with qualified published versions after upstream review/release.
The native `tsci build` command continues to use its embedded build worker.

## Qualification status

An isolated browser converter proof imported all eleven manifest namespaces and
ran twelve converter/parser operations without external requests or CSP
violations. This includes local WASM loading. Converter checks establish API
availability and basic artifact structure; they do not establish full export
fidelity. In particular, the KiCad check covers 2D document generation, not
symbol completeness or acquisition of referenced 3D models.

The compiled Linux x64 binary passes the real browser-worker and cached JSON
flows in a clean project. Checks cover all six enabled views, local thumbnail
and style-analysis artifacts, supplier links, source saves/watches, catalog
imports, error recovery, and JSON/SVG downloads. Eleven bundled namespaces and
twelve converter/parser operations run with the same request monitors active.
No external request attempts, CSP violations, browser/console errors, or failed
local requests were observed. CI repeats this with only loopback networking.
Earlier host-rendered prototype screenshots are historical, separate evidence.

`tests/dev-server.test.ts` covers source-graph preparation, invalid-source
recovery, revision-safe saves, watches, imports, request validation, and project
boundaries. Browser qualification must exercise the real local worker and all
enabled views/actions in a clean project without project dependencies or
Bun/Node on the child process PATH.

`scripts/smoke-dev-browser.ts` records browser requests, window CSP violations,
dedicated-worker security logs, console errors, and missing local assets.
Attempted forbidden requests count as failures even when CSP blocks them.
CI runs this harness in a network namespace with only loopback available;
explicit external navigation is separate from automatic resource requests.
The monitor's synthetic forbidden-request fixture calibrates detection and is
separate from product evidence.

Refresh binary notices and browser evidence after final dependency pins. Native
qualification on each advertised target, catalog expansion, full license review,
and an official release remain pending. The RP2040 example retains the explicit
schematic-placement workaround documented in
[circuit inspection](circuit-inspection.md).
