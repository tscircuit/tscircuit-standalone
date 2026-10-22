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
Both macOS binaries are signed and notarized before publication. No release is
published if a check, target build, signing, notarization or packaging step fails.

Release assets:

| Target | Primary binary | Optional archive |
| --- | --- | --- |
| Linux x64 | `tsci-linux-x64` | `tscircuit-standalone-linux-x64.tar.gz` |
| Linux arm64 | `tsci-linux-arm64` | `tscircuit-standalone-linux-arm64.tar.gz` |
| macOS x64 | `tsci-darwin-x64` | `tscircuit-standalone-macos-x64.tar.gz` |
| macOS arm64 | `tsci-darwin-arm64` | `tscircuit-standalone-macos-arm64.tar.gz` |
| Windows x64 | `tsci-windows-x64.exe` | `tscircuit-standalone-windows-x64.zip` |

Direct downloads need no extraction; keep the matching `.notices.txt` file with
the binary. On macOS/Linux, rename it to `tsci` and run `chmod +x tsci`.

Each optional archive includes `tsci` (`tsci.exe` on Windows), `LICENSE`,
`THIRD_PARTY_NOTICES`, `licenses.json` and `THIRD_PARTY_NOTICES.txt`. Extract the
archive and run `./tsci --version`, or `tsci.exe --version` on Windows. The
embedded version matches the selected npm `tscircuit` release. The release notes
identify its source commit, and `licenses.json` records compiled dependency
versions. Put the binary on your PATH to use `tsci import ESP32-S3R8`,
`tsci build my-board.circuit.tsx` and `tsci dev my-board.circuit.tsx`.

The release includes `SHA256SUMS` for all assets. Compare `sha256sum <file>` on
Linux or `shasum -a 256 <file>` on macOS with the matching entry in `SHA256SUMS`.
Each macOS `.notarization.json` records Apple's acceptance and the binary's checksum.

## macOS download quarantine

New macOS releases are signed with tscircuit Inc.'s Developer ID and notarized by
Apple. Keep browser quarantine metadata intact. The first Gatekeeper check needs
internet access because tickets cannot be stapled to standalone executables.
Older releases remain ad hoc signed.

Verify a downloaded executable with:

```sh
codesign --verify --strict --check-notarization -R='notarized' ./tsci
```

## macOS signing setup

Configure repository Actions secrets using a Developer ID Application certificate
and private key (`.p12`) and an App Store Connect team API key (`.p8`):

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64-encoded `.p12` |
| `MACOS_CERTIFICATE_PASSWORD` | `.p12` password |
| `APPLE_NOTARY_KEY_P8_BASE64` | Base64-encoded `.p8` |
| `APPLE_NOTARY_KEY_ID` | API key ID |
| `APPLE_NOTARY_ISSUER_ID` | Issuer ID |

## Release publication

Assets are uploaded to a draft before it becomes public. Published dates are
skipped on reruns. A failed upload leaves a draft that the original workflow
can retry for the same source commit and npm version, even on a later day. The
draft's title preserves its selected version, and the tag uses the original
run's creation date. Existing tags must resolve to the expected source commit,
including annotated tags. Daily workflows run serially, and only
the publishing job receives permission to write releases.

These are development prereleases. Linux x64 has native/browser execution
coverage; macOS Intel and Apple Silicon have native startup checks after
signing and notarization. Linux arm64 and Windows have cross-compilation coverage.
The archives retain the dependency inventory and collected redistribution
notices, including the existing license-review follow-ups. Official release
qualification and additional native platform tests remain separate work.
