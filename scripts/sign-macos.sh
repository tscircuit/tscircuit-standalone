#!/bin/bash
# Sign the final executable before packaging. Never fall back to ad hoc signing.
set -euo pipefail
umask 077

binary="${1:?Usage: bash scripts/sign-macos.sh path/to/tsci}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
test "$(uname -s)" = Darwin
test -s "$binary"
rm -f "$binary.notarization.json"
for name in MACOS_CERTIFICATE_P12_BASE64 MACOS_CERTIFICATE_PASSWORD APPLE_NOTARY_KEY_P8_BASE64 APPLE_NOTARY_KEY_ID APPLE_NOTARY_ISSUER_ID APPLE_TEAM_ID; do
  if [ -z "${!name:-}" ]; then
    echo "Missing required signing credential: $name" >&2
    exit 1
  fi
done
if [[ ! "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "Invalid Apple team ID" >&2
  exit 1
fi

signing_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/tsci-signing.XXXXXX")"
keychain="$signing_dir/signing.keychain-db"
original_keychains=()
search_list_changed=false
diagnostics_dir=""
log_pid=""
phase="credential setup"
cleanup() {
  result=$?
  set +e
  if [ -n "$log_pid" ]; then
    kill "$log_pid" >/dev/null 2>&1
    wait "$log_pid" >/dev/null 2>&1
  fi
  if [ -n "$diagnostics_dir" ]; then
    if [ -s "$binary" ]; then
      shasum -a 256 "$binary" > "$diagnostics_dir/final-binary.sha256"
    fi
    printf 'stage=%s\nexit_status=%s\nutc=%s\n' "$phase" "$result" \
      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$diagnostics_dir/result.txt"
    # Allowlist public diagnostic files; never copy the keychain or credentials.
    for name in signature.txt signature-verification.txt submission.json notary-log.json notarization-verification.txt; do
      if [ -f "$signing_dir/$name" ]; then
        cp "$signing_dir/$name" "$diagnostics_dir/$name"
      fi
    done
    echo "macOS signing result:"
    cat "$diagnostics_dir/result.txt"
    echo "Diagnostics saved to $diagnostics_dir"
  fi
  if [ "$search_list_changed" = true ]; then
    security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
  fi
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$signing_dir"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
diagnostics_root="${SIGNING_DIAGNOSTICS_DIR:-$(dirname "$binary")/signing-diagnostics}"
mkdir -p "$diagnostics_root"
diagnostics_dir="$(mktemp -d "$diagnostics_root/attempt.XXXXXX")"
{
  date -u '+UTC: %Y-%m-%dT%H:%M:%SZ'
  printf 'Runner OS: %s\nRunner architecture: %s\nImage: %s %s\n' \
    "${RUNNER_OS:-unknown}" "${RUNNER_ARCH:-unknown}" "${ImageOS:-unknown}" "${ImageVersion:-unknown}"
  uname -m
  if command -v sw_vers >/dev/null; then sw_vers; fi
  if command -v xcodebuild >/dev/null; then xcodebuild -version || true; fi
} > "$diagnostics_dir/runner.txt" 2>&1
cat "$diagnostics_dir/runner.txt"
security list-keychains -d user > "$signing_dir/keychains.txt"
while IFS= read -r path; do
  [ -z "$path" ] || original_keychains+=("$path")
done < <(sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//' "$signing_dir/keychains.txt")
keychain_password="$(openssl rand -hex 32)"
printf '%s' "$MACOS_CERTIFICATE_P12_BASE64" | base64 --decode > "$signing_dir/certificate.p12"
printf '%s' "$APPLE_NOTARY_KEY_P8_BASE64" | base64 --decode > "$signing_dir/notary.p8"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
# Trust evaluation must be able to find the imported G2 intermediate, even
# when codesign/find-identity receive an explicit keychain argument.
security list-keychains -d user -s "$keychain" "${original_keychains[@]}"
search_list_changed=true
security import "$signing_dir/certificate.p12" -k "$keychain" \
  -P "$MACOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  -k "$keychain_password" "$keychain" >/dev/null
# The G2 intermediate is public; importing it does not change system trust.
curl --fail --silent --show-error --retry 3 \
  https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer \
  -o "$signing_dir/DeveloperIDG2CA.cer"
security import "$signing_dir/DeveloperIDG2CA.cer" -k "$keychain"
# Some Macs keep Apple roots in the system trust store rather than the
# certificate keychain searched by codesign. Supply the public chain without
# adding or overriding any trust settings.
curl --fail --silent --show-error --retry 3 \
  https://www.apple.com/appleca/AppleIncRootCertificate.cer \
  -o "$signing_dir/AppleRootCA.cer"
security import "$signing_dir/AppleRootCA.cer" -k "$keychain"
identity="$(security find-identity -v -p codesigning "$keychain" |
  awk -v team="($APPLE_TEAM_ID)" '/Developer ID Application:/ && index($0, team) {print $2}')"
if [[ ! "$identity" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  security find-identity -p codesigning "$keychain" >&2 || true
  echo "Expected exactly one Developer ID Application identity for $APPLE_TEAM_ID" >&2
  exit 1
fi
phase="Developer ID signing"
echo "Signing the executable with Developer ID."
codesign --force --sign "$identity" --keychain "$keychain" \
  --identifier com.tscircuit.tsci --options runtime --timestamp \
  --entitlements "$script_dir/macos-entitlements.plist" "$binary"
phase="signature integrity verification"
signature_status=0
codesign --verify --strict --verbose=4 "$binary" \
  > "$signing_dir/signature-verification.txt" 2>&1 || signature_status=$?
cat "$signing_dir/signature-verification.txt"
if [ "$signature_status" -ne 0 ]; then exit "$signature_status"; fi
codesign --display --verbose=4 "$binary" 2> "$signing_dir/signature.txt"
cat "$signing_dir/signature.txt"
shasum -a 256 "$binary" > "$diagnostics_dir/signed-binary.sha256"
cat "$diagnostics_dir/signed-binary.sha256"
grep -Fx "TeamIdentifier=$APPLE_TEAM_ID" "$signing_dir/signature.txt"
grep -F 'Authority=Developer ID Application:' "$signing_dir/signature.txt"
grep -E 'flags=.*\(runtime\)' "$signing_dir/signature.txt"
grep -E '^Timestamp=.' "$signing_dir/signature.txt"

# Apple accepts ZIP submissions, and issues a ticket for the contained Mach-O.
# A standalone executable cannot have a ticket stapled to it.
phase="Apple notarization submission and wait"
echo "Submitting the signed executable to Apple; waiting up to 30 minutes."
ditto -c -k --keepParent "$binary" "$signing_dir/submission.zip"
auth=(--key "$signing_dir/notary.p8" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID")
submit_status=0
xcrun notarytool submit "$signing_dir/submission.zip" "${auth[@]}" \
  --wait --timeout 30m --output-format json > "$signing_dir/submission.json" || submit_status=$?
cat "$signing_dir/submission.json"
submission_id="$(jq -r '.id // empty' "$signing_dir/submission.json")"
if [ -n "$submission_id" ]; then
  xcrun notarytool log "$submission_id" "${auth[@]}" "$signing_dir/notary-log.json" || true
  if [ -s "$signing_dir/notary-log.json" ]; then
    cat "$signing_dir/notary-log.json"
  fi
fi
if [ "$submit_status" -ne 0 ] || ! jq -e '.status == "Accepted" and (.id | type == "string" and length > 0)' "$signing_dir/submission.json" >/dev/null; then
  echo "Apple did not accept the executable; refusing to release it." >&2
  exit 1
fi
# Unlike spctl's app assessment, this supports standalone command-line code.
phase="notarization ticket verification"
echo "Apple accepted the submission. Checking the notarization requirement once."
# Observe ticket lookup without enabling private logging or changing system policy.
if command -v log >/dev/null; then
  log stream --style compact --level debug \
    --predicate 'process == "syspolicyd" OR process == "trustd" OR process == "amfid" OR process == "taskgated-helper"' \
    > "$diagnostics_dir/notarization-system.log" 2>&1 &
  log_pid=$!
fi
verification_status=0
codesign --verify --strict --verbose=4 --check-notarization -R='notarized' "$binary" \
  > "$signing_dir/notarization-verification.txt" 2>&1 || verification_status=$?
cat "$signing_dir/notarization-verification.txt"
if [ "$verification_status" -ne 0 ]; then
  echo "Apple accepted the submission, but local ticket verification failed (exit $verification_status)." >&2
  exit "$verification_status"
fi
phase="acceptance receipt"
checksum="$(shasum -a 256 "$binary" | awk '{print $1}')"
jq --arg team "$APPLE_TEAM_ID" --arg sha256 "$checksum" \
  '{id, status, teamId: $team, sha256: $sha256}' \
  "$signing_dir/submission.json" > "$binary.notarization.json"
echo "Developer ID signing and notarization succeeded."
phase="complete"
