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
After qualification, separate native macOS jobs sign the Intel and Apple Silicon
executables with tscircuit Inc.'s Developer ID and submit each to Apple for
notarization. They check Apple's ticket and run the signed executable before
repackaging it. No release is published if a check, target build, signing,
notarization or packaging step fails. Pull request CI does not receive signing
credentials.

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
The macOS `.notarization.json` receipts record Apple's submission ID, acceptance,
team ID and the SHA-256 of the signed executable. Publication also verifies that
the executable inside each macOS archive matches its direct download.

## macOS download quarantine

Signed releases use **Developer ID Application: tscircuit Inc. (WUQ9WUY75Z)**,
a secure timestamp, hardened runtime and JavaScriptCore JIT entitlements.
Browsers can add `com.apple.quarantine` to downloads and extracted files; leave
that metadata intact. Gatekeeper uses the signature and Apple's notarization
ticket to check the executable. Signing addresses the unverified-developer and
malware-verification block; macOS may still show its normal first-open prompt.

On macOS 10.15 or later, verify a downloaded executable with:

```sh
codesign --verify --strict --verbose=2 ./tsci
codesign --verify --strict --check-notarization -R='notarized' ./tsci
codesign --display --verbose=4 ./tsci
```

Apple cannot staple tickets to standalone Mach-O executables, ZIP files or tar
archives. The first Gatekeeper check therefore requires access to Apple's
servers; subsequent circuit work can use the embedded offline resources.
See [Apple's notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).
For an offline first installation, a separately notarized and stapled installer
package or disk image would be needed.

Earlier releases without these notarization receipts remain ad hoc signed.
Download a signed release to use normal Gatekeeper verification. The
[terminal installer](../README.md#download-and-run-on-macos) continues to select
the native architecture and verify the archive against `SHA256SUMS`.

## macOS signing setup

The account holder creates a **Developer ID Application** certificate using the
G2 intermediary in the [Apple Developer account](https://developer.apple.com/account/resources/certificates/list).
Export that certificate and its private key together as a password-protected
PKCS#12 file. Create an App Store Connect **team** API key with the **Developer**
role for notarization. Keep its private `.p8` file and note the key ID and issuer
ID. These credentials authorize signing as tscircuit Inc. and notarization;
the API key also has Developer access to the team's App Store Connect apps.

Configure these encrypted Actions secrets only in `tscircuit/tscircuit-standalone`:

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64 encoding of the certificate and private key PKCS#12 |
| `MACOS_CERTIFICATE_PASSWORD` | Password used to export that PKCS#12 |
| `APPLE_NOTARY_KEY_P8_BASE64` | Base64 encoding of the notarization API private key |
| `APPLE_NOTARY_KEY_ID` | App Store Connect API key ID |
| `APPLE_NOTARY_ISSUER_ID` | App Store Connect team issuer ID |

Never commit these files or secret values. The signing script imports the
identity into a temporary keychain and deletes it and the decoded credentials
on success or failure. Only the signing step receives the secrets; build and
pull request jobs remain independent of them. Manual releases forward the same
secrets to the daily release workflow. Missing or invalid credentials fail the
release instead of silently producing unsigned downloads.

After merging the signing workflow and configuring the secrets, run **Manual
standalone release** from `main`. Check both signing jobs for an accepted Apple
submission. Download each binary through a browser on a fresh Mac, retain its
quarantine metadata, and run it from Terminal with internet available to verify
the user experience. A CI ticket check is useful but does not replace this
end-to-end Gatekeeper test.

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
