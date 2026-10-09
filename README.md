# tscircuit standalone

An offline distribution of tscircuit, with popular components represented by
compact footprinter strings and distributed in a compiled executable.

This preparation binary imports bundled components and builds local circuits
with an embedded evaluator and local routing. Builds produce Circuit JSON,
PCB and schematic SVG previews, and a diagnostic report. The initial catalog
contains one verified part: RP2040/C2040. `tsci dev` serves a bundled RunFrame
with local editing, rebuilding, catalog imports, PCB/schematic/procedural 3D,
BOM, and Circuit JSON views. Simulation, additional exports, and catalog expansion remain in the
[implementation plan](docs/implementation-plan.md). No official release has
been published.

## Try the foundation

```sh
bun install --frozen-lockfile
bun run check
./dist/tsci import C2040
./dist/tsci catalog C2040
./dist/tsci import C2040 --output -
./dist/tsci build examples/led-resistor.circuit.tsx
./dist/tsci build examples/rp2040-breakout.circuit.tsx --output-dir build/rp2040
./dist/tsci build examples/supplier-footprint.circuit.tsx --timeout-ms 60000
./dist/tsci dev examples/rp2040-breakout.circuit.tsx --port 3020
```

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
The binary renders circuits and supplies JSON to RunFrame; all enabled browser
assets, including the CAD engine and font, are embedded. Cloud controls,
telemetry, stock lookups, remote thumbnails, and remote style analysis are
disabled. See [offline RunFrame](docs/offline-runframe.md) for architecture,
the open upstream PRs, browser qualification, and current limits.

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
with a host-rendered RunFrame and bundled viewer assets. This adapter alone does
not make the general upstream CLI or RunFrame offline; reusable integration
work remains documented in the plan.

## Binary preparation

`bun run build` produces a host binary at `dist/tsci` (`tsci.exe` on Windows).
It also generates `dist/licenses.json`, `dist/THIRD_PARTY_NOTICES.txt`, and the
backend/frontend compiler metafiles. Keep the generated notices beside the binary. The current
inventory covers 240 package roots with 73 follow-up flags; it is not full
license certification. Bun's linked native libraries and prebuilt WASM require
further release review, including the LGPL requirements in Bun's license overview.
Set `BUN_BUILD_TARGET` to one of `bun-linux-x64`, `bun-linux-arm64`,
`bun-darwin-x64`, `bun-darwin-arm64`, or `bun-windows-x64` to cross-compile.
The local compiled-binary smoke builds all three examples and a circuit using a
freshly generated `imports/C2040.tsx` from `src/`, in a clean project with no
Bun/Node runtime on PATH or project `node_modules`. Native execution has
been checked on Linux x64. [CI qualification](https://github.com/tscircuit/tscircuit-standalone/actions/runs/37892852019)
passed the initial 63 tests, native socket tracing with zero network attempts on the
exercised paths, network-namespace imports/builds, and compilation for all five
targets. The offline RunFrame PR adds dev-server and browser checks, with the
compiled browser workflow run in a network namespace permitting only loopback.
Cross-compilation does not establish native support. Native smoke tests on every advertised target,
checksums, signing, license inventory, and further runtime qualification remain
release gates; no production release is automated yet.

Read the [catalog admission policy](docs/catalog-policy.md),
[upstream audit](docs/runtime-audit.md), and [CLI audit](docs/cli-audit.md).

Licensed under MIT. Adapted RP2040 metadata is attributed in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
