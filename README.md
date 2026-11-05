# tscircuit standalone

A compiled Bun executable that launches the shared `@tscircuit/cli` and embeds
the JS CDN packages requested by RunFrame's `internal-dynamic-import` calls.

## Terminal installation

**macOS / Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/tscircuit/tscircuit-standalone/main/scripts/install.sh | sh
```

**Windows (PowerShell)**

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/tscircuit/tscircuit-standalone/main/scripts/install-windows.ps1 | Out-String | iex
```

These install the latest published release, including prereleases, without
requesting administrator access. Windows opens its per-user setup wizard with
a destination folder picker. The macOS/Linux command offers a destination choice
when run in a terminal; press Enter to use the current user's `~/.local/bin`.
On macOS, a custom destination receives a portable copy of `tsci` and its licenses;
on Linux, a custom prefix receives `bin/tsci` and its managed license bundle.
Linux needs `jq` or Python 3 to select the latest release.

Run `"$HOME/.local/bin/tsci" --version` after a default Unix installation. To use
`tsci` by name, add `~/.local/bin` to your shell's PATH. The installer prints the
command to use for a custom destination. It never edits shell configuration.

For unattended Unix installation, set `TSCI_NONINTERACTIVE=1` on the `sh` process.
Linux also accepts `TSCI_INSTALL_PREFIX=/absolute/writable/path`. An explicit
release tag and portable destination can be passed on either platform with
`sh -s -- TAG ./tsci` instead of `sh`; then run `./tsci/tsci`.
On Windows, download the PowerShell script and run it with
`-Silent -Destination 'C:\Users\me\Tools\tscircuit'` to choose a folder unattended.
Unwritable destinations fail without requesting elevated permissions.

## Download and run on macOS

Open the newest published [release](https://github.com/tscircuit/tscircuit-standalone/releases)
and download the **Apple Silicon** or **Intel** `.pkg` installer. Double-click it,
follow the prompts, and choose a folder in your home directory on the customization
page. The default prefix is `~/.local`, with the command in `bin/tsci` and licenses
in `share/tscircuit-standalone`. Run `"$HOME/.local/bin/tsci" --version`, or add the
chosen prefix's `bin` directory to PATH. Installation uses only the current user's
permissions; no Bun, Node.js or administrator access is needed.

macOS releases are signed with tscircuit Inc.'s Developer ID and notarized by
Apple. See [macOS download verification](docs/releases.md#macos-download-quarantine).

## Download and run on Windows

Download `tscircuit-standalone-windows-x64-setup.exe` from the newest published
[release](https://github.com/tscircuit/tscircuit-standalone/releases). Run setup,
choose a writable destination folder,
then open a **new terminal** and use `tsci` or `tscircuit`. If an existing command
is found, setup asks before making standalone the default. Existing npm packages
stay installed. No Node.js, Bun or administrator access is needed.

Windows releases are signed as tscircuit Inc and timestamped. See
[Windows installation and development](docs/releases.md#windows-installer)
for unattended installation, command precedence, building and testing.

## Download and run on Linux

Use the terminal command above or extract the matching `.tar.gz` archive from
the newest [release](https://github.com/tscircuit/tscircuit-standalone/releases)
and run `./tsci --version`. Linux x64 and arm64 are available. The terminal
installer retains the licenses, updates only its own installation, and refuses
to replace an existing npm or manually installed `tsci` command.

## Build from source

```sh
bun install --frozen-lockfile
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

The **Tests** workflow runs typechecks, the regression suite, native installer
tests and unsigned Windows installer verification on pull requests and `main`.
It also calls the reusable **Build standalone artifacts** workflow, which manual
and daily releases call directly. Builds prepare the embedded assets once, then
compile all five targets in parallel. The Linux x64 build runs the compiled CLI
and offline browser verification once, alongside the other target builds.

Releases keep the checks for the selected upstream version and the actual signed
downloads: offline browser/worker/WASM checks, native signed executable startup,
signed installer verification, signing/notarization receipts and checksums.
They do not rebuild the prototype UI, rerun the regression suite or build a
second, unsigned Windows installer before signing.

Set `BUN_BUILD_TARGET` to `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`,
`bun-darwin-arm64`, or `bun-windows-x64` to cross-compile. The build emits the
binary, compiler graphs, `dist/licenses.json` and `dist/THIRD_PARTY_NOTICES.txt`.
Keep the notices with redistributed binaries. Use the CI-pinned Bun versions to
match the vendored runtime notices; cross-compilation does not establish native
runtime support on each target.

Licensed under MIT. Adapted RP2040 metadata is attributed in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
