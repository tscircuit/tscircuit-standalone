# Daily binary releases

After the daily workflow is merged, GitHub Actions builds `main` every day and
publishes a dated prerelease under `daily-YYYY-MM-DD`. The scheduled time is
10:17 UTC. GitHub may start scheduled workflows later than their configured time.
Maintainers can also run **Daily standalone release** manually from `main`.

The workflow reuses the normal CI checks: frozen installation, typechecks,
tests, compiled-binary smoke, browser qualification and native network tracing.
It then compiles all five targets from the same qualified catalog and UI bundle.
No release is published if a check, target build or packaging step fails.

Release assets:

| Target | Archive |
| --- | --- |
| Linux x64 | `tscircuit-standalone-linux-x64.tar.gz` |
| Linux arm64 | `tscircuit-standalone-linux-arm64.tar.gz` |
| macOS x64 | `tscircuit-standalone-macos-x64.tar.gz` |
| macOS arm64 | `tscircuit-standalone-macos-arm64.tar.gz` |
| Windows x64 | `tscircuit-standalone-windows-x64.zip` |

Each archive includes `tsci` (`tsci.exe` on Windows), `LICENSE`,
`THIRD_PARTY_NOTICES`, `licenses.json` and `THIRD_PARTY_NOTICES.txt`. Extract the
archive and run `./tsci --version`, or `tsci.exe --version` on Windows. The
embedded version includes the release date and source commit. Put the binary
on your PATH to use `tsci import ESP32-S3R8`, `tsci build` and `tsci dev`.

The release also includes `SHA256SUMS`. On Linux, verify downloaded archives
with `sha256sum --check SHA256SUMS` from their directory; on macOS use
`shasum -a 256 --check SHA256SUMS`.

Assets are uploaded to a draft before it becomes public. Published dates are
skipped on reruns. A failed upload leaves a draft that the original workflow
can retry for the same source commit, even on a later day. The tag uses the
original run's creation date. Daily workflows run serially, and only
the publishing job receives permission to write releases.

These are development prereleases. Linux x64 has native/browser execution
coverage; the other four targets currently have cross-compilation coverage.
The archives retain the dependency inventory and collected redistribution
notices, including the existing license-review follow-ups. Official release
qualification, additional native platform tests and signing remain separate
work.
