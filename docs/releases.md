# Daily binary releases

After the daily workflow is merged, GitHub Actions builds `main` every day and
publishes a dated prerelease under `daily-YYYY-MM-DD`. Each run selects the latest
npm `tscircuit` version. The release title and `tsci --version` use that exact
version; the date stays in the tag so builds remain daily when npm hasn't changed.
The scheduled time is 3:17 AM Pacific during daylight saving time, or 2:17 AM
during standard time. GitHub may start scheduled workflows later than configured.
Maintainers can also run **Daily standalone release** manually from `main`.
To qualify a selected upstream version without publishing, run **Check standalone
preparation** manually with its `tscircuit_version` input.

The selected npm release determines the bundled core, evaluator, props and
compiler peer helpers. Preparation updates these dependencies and creates one
lockfile before qualification. Every target installs that lockfile with frozen
installation and compiles the same qualified catalog and UI bundle.

The workflow reuses the normal CI checks: frozen installation, typechecks,
tests, compiled-binary smoke, browser qualification and native network tracing.
It then compiles all five targets from the same qualified catalog and UI bundle.
No release is published if a check, target build or packaging step fails.

The primary release downloads are directly runnable binaries. The release notes
link to each executable and its matching `.notices.txt` file before the build
details. Download both files for your platform; no archive extraction or Bun/Node
installation is required.

| Target | Primary binary | Optional archive |
| --- | --- | --- |
| Linux x64 | `tsci-linux-x64` | `tscircuit-standalone-linux-x64.tar.gz` |
| Linux arm64 | `tsci-linux-arm64` | `tscircuit-standalone-linux-arm64.tar.gz` |
| macOS Intel | `tsci-darwin-x64` | `tscircuit-standalone-macos-x64.tar.gz` |
| macOS Apple Silicon | `tsci-darwin-arm64` | `tscircuit-standalone-macos-arm64.tar.gz` |
| Windows x64 | `tsci-windows-x64.exe` | `tscircuit-standalone-windows-x64.zip` |

On macOS/Linux, rename the executable to `tsci`, run `chmod +x tsci`, then run
`./tsci --version`. On Windows, rename it to `tsci.exe` and run
`.\tsci.exe --version` in PowerShell. The embedded version matches the selected
npm `tscircuit` release. Put the binary on your PATH to use `tsci import ESP32-S3R8`,
`tsci build my-board.circuit.tsx` and `tsci dev my-board.circuit.tsx`.

Each companion notices file (for example, `tsci-linux-x64.notices.txt`) contains
the complete contents of `LICENSE`, `THIRD_PARTY_NOTICES`, `licenses.json` and
`THIRD_PARTY_NOTICES.txt` for that target. Keep it with the binary when
redistributing it. The optional archives contain the same executable and those
four files separately. The release notes identify the source commit, and the
inventory records compiled dependency versions.

The release also includes `SHA256SUMS`, covering all five binaries, five notices
files and five optional archives. Before renaming your download, run
`sha256sum tsci-linux-x64` on Linux or `shasum -a 256 tsci-darwin-arm64` on macOS,
substituting your filename, and compare the result with its entry in
`SHA256SUMS`. On Windows, use `Get-FileHash .\tsci-windows-x64.exe -Algorithm SHA256`
in PowerShell. Verify the companion notices file the same way. If you downloaded
every asset, use `sha256sum --check SHA256SUMS` on Linux or
`shasum -a 256 --check SHA256SUMS` on macOS.

Assets are uploaded to a draft before it becomes public. Published dates are
skipped on reruns. A failed upload leaves a draft that the original workflow
can retry for the same source commit and npm version, even on a later day. The
draft's title preserves its selected version, and the tag uses the original
run's creation date. Existing tags must resolve to the expected source commit,
including annotated tags. Daily workflows run serially, and only
the publishing job receives permission to write releases.

These are development prereleases. Linux x64 has native/browser execution
coverage; the other four targets currently have cross-compilation coverage.
The companion notices and archives retain the dependency inventory and collected
redistribution notices, including the existing license-review follow-ups. Official release
qualification, additional native platform tests and signing remain separate
work.
