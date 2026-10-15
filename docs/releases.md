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
embedded version matches the selected npm `tscircuit` release. The release notes
identify its source commit, and `licenses.json` records compiled dependency
versions. Put the binary on your PATH to use `tsci import ESP32-S3R8`,
`tsci build my-board.circuit.tsx` and `tsci dev my-board.circuit.tsx`.

The release also includes `SHA256SUMS`. On Linux, verify downloaded archives
with `sha256sum --check SHA256SUMS` from their directory; on macOS use
`shasum -a 256 --check SHA256SUMS`.

## macOS download quarantine

The macOS binaries are ad hoc signed, without an Apple Developer ID or
notarization. Browsers such as Chrome add `com.apple.quarantine` metadata to
downloads; Archive Utility can propagate it to the extracted binary. This
metadata is added on the user's Mac, not by the build or release archive, so
changing release packaging cannot prevent it on browser downloads.

For installation without browser quarantine, use the [terminal installer](../README.md#download-and-run-on-macos).
It selects the native architecture, downloads the specified release and verifies
its archive against `SHA256SUMS` before extracting it. It does not remove
quarantine from existing files or change system security settings.

For an archive already downloaded through a browser, verify its checksum first.
If you trust the release, enter its extracted directory and run:

```sh
xattr -d com.apple.quarantine ./tsci
./tsci --version
```

This removes the download quarantine check for that executable. If `xattr`
reports that the attribute does not exist, it has already been cleared or was
never attached. Alternatively, use **System Settings → Privacy & Security →
Open Anyway** after the blocked launch, as described by
[Apple](https://support.apple.com/102445).

Wi-Fi does not need to be disabled to launch the binary. Offline qualification
tests are separate from Gatekeeper's download checks. Developer ID signing and
notarization would be needed for a release that passes the normal Gatekeeper
checks after a browser download.

## Release publication

Assets are uploaded to a draft before it becomes public. Published dates are
skipped on reruns. A failed upload leaves a draft that the original workflow
can retry for the same source commit and npm version, even on a later day. The
draft's title preserves its selected version, and the tag uses the original
run's creation date. Existing tags must resolve to the expected source commit,
including annotated tags. Daily workflows run serially, and only
the publishing job receives permission to write releases.

These are development prereleases. Linux x64 has native/browser execution
coverage; the other four targets currently have cross-compilation coverage.
The archives retain the dependency inventory and collected redistribution
notices, including the existing license-review follow-ups. Official release
qualification, additional native platform tests and signing remain separate
work.
