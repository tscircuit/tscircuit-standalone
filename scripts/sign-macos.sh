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
cleanup() {
  if [ "$search_list_changed" = true ]; then
    security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
  fi
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$signing_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
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
codesign --force --sign "$identity" --keychain "$keychain" \
  --identifier com.tscircuit.tsci --options runtime --timestamp \
  --entitlements "$script_dir/macos-entitlements.plist" "$binary"
codesign --verify --strict --verbose=2 "$binary"
codesign --display --verbose=4 "$binary" 2> "$signing_dir/signature.txt"
grep -Fx "TeamIdentifier=$APPLE_TEAM_ID" "$signing_dir/signature.txt"
grep -F 'Authority=Developer ID Application:' "$signing_dir/signature.txt"
grep -E 'flags=.*\(runtime\)' "$signing_dir/signature.txt"
grep -E '^Timestamp=.' "$signing_dir/signature.txt"

# Apple accepts ZIP submissions, and issues a ticket for the contained Mach-O.
# A standalone executable cannot have a ticket stapled to it.
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
codesign --verify --strict --check-notarization -R='notarized' "$binary"
checksum="$(shasum -a 256 "$binary" | awk '{print $1}')"
jq --arg team "$APPLE_TEAM_ID" --arg sha256 "$checksum" \
  '{id, status, teamId: $team, sha256: $sha256}' \
  "$signing_dir/submission.json" > "$binary.notarization.json"
echo "Developer ID signing and notarization succeeded."
