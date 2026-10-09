# tscircuit standalone

An offline distribution of tscircuit, with popular components represented by
compact footprinter strings and distributed in a compiled executable.

This repository contains the first working foundation. The preparation binary
supports local catalog inspection and component import. Full circuit builds,
`dev`, RunFrame, and exports require the upstream work in the
[implementation plan](docs/implementation-plan.md).

## Try the foundation

```sh
bun install --frozen-lockfile
bun run check
./dist/tsci import C2040
./dist/tsci catalog C2040
./dist/tsci import C2040 --output -
```

The default import creates `imports/C2040.tsx`, exporting `RP2040`. Existing
files are preserved. The emitted component includes its footprint, all 57 pin
labels, manufacturer identity, and supplier number. It contains no remote CAD
model assets. Unbundled parts produce a local error without a network fallback.
The generated TSX is intended for a tscircuit project; this prototype does not
yet execute that project.

The compiled executable embeds Bun and its runtime dependencies. Its supported
commands need no installed Bun/Node runtime, package installation, token, or
internet connection. Build-time dependency installation is allowed. The initial
catalog includes one verified part, RP2040/C2040; catalog expansion is planned.

## Custom platform

```ts
import { createStandalonePlatformConfig } from "@tscircuit/standalone"

const platform = createStandalonePlatformConfig()
// Pass `platform` to a compatible Circuit/RootCircuit runtime.
// In workers, create the platform inside the worker.
```

The platform supplies a local parts engine and JLC footprint library. It disables
stock checks, cloud autorouting, and analog simulation, and rejects unknown
requests. Catalog metadata/source/footprints are available through its local
`standalone://parts/C2040/...` resolver. This adapter alone does not make the
current upstream CLI or RunFrame offline: the audited global-fetch, provider,
telemetry, CDN, and worker gaps are documented in the plan.

## Binary preparation

`bun run build` produces a host binary at `dist/tsci` (`tsci.exe` on Windows).
Set `BUN_BUILD_TARGET` to one of `bun-linux-x64`, `bun-linux-arm64`,
`bun-darwin-x64`, `bun-darwin-arm64`, or `bun-windows-x64` to cross-compile.
CI checks the Linux prototype without network access and prepares build
artifacts for all five targets. Native smoke tests on every target, checksums,
signing, and complete runtime integration are release gates; no production
release is automated yet.

Read the [catalog admission policy](docs/catalog-policy.md),
[upstream audit](docs/runtime-audit.md), and [CLI audit](docs/cli-audit.md).

Licensed under MIT. Adapted RP2040 metadata is attributed in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
