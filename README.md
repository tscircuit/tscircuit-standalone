# tscircuit standalone

An offline distribution of tscircuit, with popular components represented by
compact footprinter strings and distributed in a compiled executable.

This preparation binary imports bundled components and builds local circuits
with an embedded evaluator and local routing. Builds produce Circuit JSON,
PCB and schematic SVG previews, and a diagnostic report. The initial catalog
contains one verified part: RP2040/C2040. `tsci dev` serves a bundled RunFrame
with local editing, rebuilding, catalog imports, PCB/schematic/procedural 3D,
BOM, and Circuit JSON views. The dev app runs the ordinary RunFrame browser
worker with bundled dependencies and the existing platform providers. Browser
qualification is recorded in the [RunFrame notes](docs/offline-runframe.md).
Simulation, additional exports, catalog expansion, and
release qualification remain in the [implementation plan](docs/implementation-plan.md).
No official release has been published.

## Try the foundation

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
./dist/tsci import C2040
./dist/tsci catalog C2040
./dist/tsci import C2040 --output -
./dist/tsci build examples/led-resistor.circuit.tsx
./dist/tsci build examples/rp2040-breakout.circuit.tsx --output-dir build/rp2040
./dist/tsci build examples/supplier-footprint.circuit.tsx --timeout-ms 60000
./dist/tsci dev examples/rp2040-breakout.circuit.tsx --port 3020
```

The browser build uses packaged WASM and local adapters. Installation skips
unused native dependency installers with `--ignore-scripts`.

The default import creates `imports/C2040.tsx`, exporting `RP2040`. Existing
files are preserved. The emitted component includes its footprint, all 57 pin
labels, manufacturer identity, and supplier number. It contains no remote CAD
model assets. Unbundled parts produce a local error without a network fallback.
The emitted TSX can be imported by a local circuit and built by this binary.
The supplier-footprint example also exercises `footprint="jlcpcb:C2040"`
directly through the custom platform.

The compiled executable embeds Bun and its runtime dependencies. Its supported
commands need no installed Bun/Node runtime, package installation, token, or
internet connection for the supported source and feature subset below.
Build-time dependency installation is allowed.

## Build local circuits

```sh
./dist/tsci build src/main.circuit.tsx --project-dir . --output-dir build --timeout-ms 60000
```

For `main.circuit.tsx`, this writes `main.circuit.json`,
`main.circuit.pcb.svg`, `main.circuit.schematic.svg`, and
`main.circuit.report.json`. Build files with the same names are replaced.
Circuit diagnostics are retained in the report. DRC errors such as overlapping
footprints produce exit code 1 and retain JSON/SVG/report artifacts for inspection;
warnings alone produce exit code 0. Missing dependencies, parts, remote
assets, and unsupported features fail locally before build artifacts are written.

The loader reads the reachable local TS/TSX/JS/JSX/MTS/CTS/MJS/CJS/JSON source
graph, limited to 100 files and 2 MiB. Static local imports and an exact embedded
module allowlist are supported. Dynamic imports, top-level await, CommonJS
`require`, arbitrary packages or package subpaths, project configuration imports, and reads from
`node_modules` are rejected. The default project boundary is the current
directory when it contains the entry file, otherwise the entry's directory;
`--project-dir` sets it explicitly. Imports and symlinks must stay inside it.

The host selects the offline platform in a fresh embedded worker. Builds reject
custom parts engines, cloud routing, unknown supplier/MPN declarations, and
external footprint/model/image assets. Generic passives with local footprints
can be used without a sourced MPN; the report retains their BOM warnings.
These worker guards cover the supported evaluator paths. They are not an OS
sandbox for arbitrary adversarial TypeScript.

See [circuit inspection](docs/circuit-inspection.md) for reviewable PCB/schematic
previews, fixture measurements, thermal-pad connectivity checks, the schematic
auto-layout workaround, and the meaning of the remaining warnings.

## Preview and edit locally

`./dist/tsci dev <entry>` prints a loopback URL to open in your browser. Save and
rebuild from the entry-source editor, edit dependencies externally to trigger
the watcher, import C2040 from the embedded catalog, and download local Circuit
JSON/PCB SVG/schematic SVG. External edits are preserved through revision checks.
The binary serves the local source graph and bundled assets. RunFrame evaluates
that source in its normal browser worker, using pinned eval 0.0.1569 and the
standalone platform. A Circuit JSON entry uses RunFrame's existing file-viewing
path after array/element and asset validation; its part identity metadata need not be in
the catalog because no part lookup is performed. Dependency imports, CAD/WASM/fonts, schematic thumbnails,
and style analysis use bundled implementations. Supplier availability is
unknown through the existing parts engine; no snapshot stock or price is
invented. RunFrame's local `RunFramePlatformConfig` carries
`telemetryDisabled`, `evalCdnLoadingDisabled`, `evalVersionSelectionDisabled`,
and `pcbRenderer` through its existing platform prop. Supplier hyperlinks and
the existing autorouting-report callback remain available for
user navigation; application fetches and automatic CDN loads cannot depend on
external access. See [bundled RunFrame](docs/offline-runframe.md) for the open
upstream PRs, qualification status, and current limits. Browser execution
currently has no deadline; an accidental infinite loop can require a page
reload. `--timeout-ms` applies to native `build` only.

## Custom platform

```ts
import { createStandalonePlatformConfig } from "@tscircuit/standalone"

const platform = createStandalonePlatformConfig()
// Pass `platform` to a compatible Circuit/RootCircuit runtime.
// In workers, create the platform inside the worker.
```

The platform supplies a local parts engine and JLC footprint library. It disables
stock checks, cloud autorouting, and analog simulation, and rejects unknown
requests. The build worker also replaces eval's online provider defaults with
local or rejecting providers and treats swallowed request/effect failures as
build failures. Catalog metadata/source/footprints are available through the local
`standalone://parts/C2040/...` resolver. The standalone dev command combines it
with ordinary RunFrame source execution, an embedded browser worker, a bundled
dynamic-module manifest, and parts-engine availability. The schematic viewer
generates footprint SVGs locally and loads style analysis through the generic
importer. The worker constructs
the platform locally; native Response objects are not sent through Comlink.
Reusable upstream CLI composition and provider-policy work remain in the plan.

## Binary preparation

`bun run build` produces a host binary at `dist/tsci` (`tsci.exe` on Windows).
It also generates `dist/licenses.json`, `dist/THIRD_PARTY_NOTICES.txt`, and the
backend/frontend compiler metafiles, including browser-worker inputs and copied
assets. Keep the generated notices beside the binary. The inventory reports
exact graph counts and follow-up flags for each build; full native Bun/WASM
redistribution review remains required, including the LGPL requirements in
Bun's license overview.

Set `BUN_BUILD_TARGET` to one of `bun-linux-x64`, `bun-linux-arm64`,
`bun-darwin-x64`, `bun-darwin-arm64`, or `bun-windows-x64` to cross-compile.
The native CLI smoke builds the examples and a freshly generated C2040 import
in a clean project without project dependencies or Bun/Node on PATH.
[Earlier CLI qualification](https://github.com/tscircuit/tscircuit-standalone/actions/runs/37892852019)
passed import/build tests, socket tracing, network-namespace execution, and all
five compilation targets on the initial foundation. Those results do not
qualify the revised RunFrame browser worker or its expanded dependency graph.
The current compiled Linux x64 browser proof covers source and cached JSON
flows, twelve bundled namespaces, the analyzer's exact version alias, and
thirteen operations with zero external request attempts or CSP violations.
CI runs the harness with only loopback networking. Native execution beyond
Linux x64, checksums, signing, notices, and per-feature runtime checks remain
release gates. Cross-compilation alone does not establish native support.

Read the [catalog admission policy](docs/catalog-policy.md),
[upstream audit](docs/runtime-audit.md), and [CLI audit](docs/cli-audit.md).

Licensed under MIT. Adapted RP2040 metadata is attributed in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
