# tscircuit standalone

A compiled Bun executable that launches the shared `@tscircuit/cli` and embeds
the JS CDN packages requested by RunFrame's `internal-dynamic-import` calls.

## Download and run on macOS

Open the newest published [release](https://github.com/tscircuit/tscircuit-standalone/releases)
and download the **Apple Silicon** or **Intel** `.pkg` installer. Double-click it,
follow the prompts, then open Terminal and run `tsci --version`. The installer
requires administrator approval and installs the command on PATH; no Bun, Node.js
or manual permission changes are needed.

### Terminal installation

The terminal installer is also available, including for development prereleases:

```sh
release_tag=$(curl --fail --location --silent --show-error 'https://api.github.com/repos/tscircuit/tscircuit-standalone/releases?per_page=1' |
  plutil -extract 0.tag_name raw -o - -)
curl --fail --location --silent --show-error https://raw.githubusercontent.com/tscircuit/tscircuit-standalone/main/scripts/install-macos.sh | sh -s -- "$release_tag"
./tscircuit-standalone-"$release_tag"/tsci --version
```

The installer selects Apple Silicon or Intel, checks the archive against the
release's `SHA256SUMS`, and keeps the executable and license notices together.
An optional second argument sets the destination directory; existing directories
are left untouched. No Apple account, Bun/Node installation or `sudo` is needed.

macOS releases are signed with tscircuit Inc.'s Developer ID and notarized by
Apple. See [macOS download verification](docs/releases.md#macos-download-quarantine).

## Build from source

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
./dist/tsci --help
./dist/tsci dev examples/led-resistor.circuit.tsx
./dist/tsci build examples/led-resistor.circuit.tsx --site
```

The build follows the pinned CLI's RunFrame dependency graph, bundles its dynamic
imports from installed packages, and reuses the existing browser/WASM adapters.
No CDN downloads or package installation happen when preparing the JS CDN at
runtime. The shared CLI is pinned to a merged GitHub commit until its changes
are available in an npm release; its locked build dependencies are installed
during `bun run build`.

At startup, the executable extracts its embedded JS CDN files into a temporary
directory and sets `TSCIRCUIT_STANDALONE=1` and `TSCIRCUIT_JSCDN_DIR` before
loading the CLI. Bun's embedded filesystem exposes individual files, so this
real directory allows the CLI's existing directory-copy and static-file handlers
to work. The directory is removed on normal process exit.

- `tsci dev` serves the bundled files at `/jscdn/*`.
- `tsci build --site` automatically copies them to `dist/jscdn` and sets the
  site's JS CDN base URL to `./jscdn`.
- Bundled module and WASM URLs also work when the site is hosted below a subpath.

The shared CLI retains its normal behavior for other services, including remote
parts, routing and browser resources. Embedding the JS CDN packages does not
make every CLI command or RunFrame feature offline.

## Manual releases

In GitHub Actions, select **Manual standalone release**, click **Run workflow**,
choose `main`, and enter an exact upstream tscircuit version or leave `latest`.
You can also trigger it with:

```sh
gh workflow run manual-release.yml --ref main -f tscircuit_version=latest
```

Manual runs publish a prerelease tagged `manual-YYYY-MM-DD-RUN_ID`, so they can
publish even when that day's daily release already exists. They use the same
qualification checks, five platform archives, and `SHA256SUMS` as nightly releases.
Rerunning the original run resumes its draft using the original tag and version;
a published release is left unchanged. Publishing is restricted to `main`.

## Validation and release preparation

`bun run check` builds the prototype UI fixtures, builds the executable, runs
typechecks and unit tests, then exercises the compiled `tsci build` and `tsci dev`
in a project with no dependencies or Bun/Node on PATH. After installing Chromium
with `bunx playwright install chromium`, run `bun scripts/smoke-binary.ts --browser`
to check every CDN module and a WASM exporter at dev and nested static-site URLs,
and 3D rendering of a board with an embedded STEP model in the compiled dev
viewer. The viewer and exporters share a single OCCT loader/WASM pair.
CI runs this browser check with only loopback networking.

Set `BUN_BUILD_TARGET` to `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`,
`bun-darwin-arm64`, or `bun-windows-x64` to cross-compile. The build emits the
binary, compiler graphs, `dist/licenses.json` and `dist/THIRD_PARTY_NOTICES.txt`.
Keep the notices with redistributed binaries. Use the CI-pinned Bun 1.3.14 to
match the vendored runtime notices; cross-compilation does not establish native
runtime support on each target.

Licensed under MIT. Adapted RP2040 metadata is attributed in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
