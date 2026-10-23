#!/bin/sh
# Install the signed macOS package, or extract an archive to an explicit directory.
set -eu

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

if [ "$#" -gt 2 ]; then
  fail "Usage: sh install-macos.sh [RELEASE_TAG|latest] [DESTINATION]"
fi
validate_release_tag() {
  case "$1" in
    ''|*[!a-zA-Z0-9._-]*|[!a-zA-Z0-9]*) fail "Invalid release tag: $1" ;;
  esac
}
release_tag=${1-latest}
validate_release_tag "$release_tag"

[ "$(uname -s)" = Darwin ] || fail "This installer is for macOS."
case "$(uname -m)" in
  arm64) architecture=arm64 ;;
  x86_64) architecture=x64 ;;
  *) fail "Unsupported macOS architecture: $(uname -m)" ;;
esac
for tool in curl shasum tar mktemp; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required command not found: $tool"
done

staging=$(mktemp -d "${TMPDIR:-/tmp}/tsci-install.XXXXXXXX")
trap 'rm -rf "$staging"' 0
trap 'exit 1' HUP INT TERM

if [ "$release_tag" = latest ]; then
  command -v plutil >/dev/null 2>&1 || fail "Required command not found: plutil"
  # The releases list includes published prereleases; /releases/latest does not.
  curl --fail --location --silent --show-error --connect-timeout 15 --max-time 60 --retry 3 \
    'https://api.github.com/repos/tscircuit/tscircuit-standalone/releases?per_page=1' -o "$staging/releases.json"
  release_tag=$(plutil -extract 0.tag_name raw -expect string -o - "$staging/releases.json" 2>/dev/null) ||
    fail "Could not determine the latest published release."
  validate_release_tag "$release_tag"
fi

destination=${2-}
if [ -n "$destination" ]; then
  # An explicit directory retains the portable, unprivileged archive installation.
  case "$destination" in
    /*) ;;
    *) destination=./$destination ;;
  esac
  [ ! -e "$destination" ] && [ ! -L "$destination" ] || fail "Destination already exists: $destination"
  archive=tscircuit-standalone-macos-$architecture.tar.gz
else
  for tool in pkgutil spctl sudo; do
    command -v "$tool" >/dev/null 2>&1 || fail "Required command not found: $tool"
  done
  archive=tscircuit-standalone-macos-$architecture.pkg
fi
release_url=https://github.com/tscircuit/tscircuit-standalone/releases/download/$release_tag
# curl does not add the quarantine metadata attached by browser downloads.
curl --fail --location --silent --show-error --connect-timeout 15 --max-time 300 --retry 3 \
  "$release_url/$archive" -o "$staging/$archive"
curl --fail --location --silent --show-error --connect-timeout 15 --max-time 300 --retry 3 \
  "$release_url/SHA256SUMS" -o "$staging/SHA256SUMS"

# Verify only the selected archive; the manifest also lists other platforms.
awk -v name="$archive" '$2 == name { print; count++ } END { if (count != 1) exit 1 }' \
  "$staging/SHA256SUMS" > "$staging/selected-checksum" || fail "Missing or duplicate archive checksum."
(cd "$staging" && shasum -a 256 --check selected-checksum) || fail "Archive checksum verification failed."

if [ -z "$destination" ]; then
  signature=$(pkgutil --check-signature "$staging/$archive") || fail "Installer signature verification failed."
  printf '%s\n' "$signature" | grep -Fq 'Developer ID Installer: tscircuit Inc. (WUQ9WUY75Z)' ||
    fail "Unexpected installer signing identity."
  spctl --assess --type install "$staging/$archive" || fail "Apple Gatekeeper did not accept the installer."
  printf 'Installing tsci to /usr/local/bin. Administrator approval may be required.\n'
  sudo /usr/sbin/installer -pkg "$staging/$archive" -target /
  printf 'Installed tsci. Run: tsci --version\n'
  exit 0
fi

mkdir "$staging/extracted"
tar -xzf "$staging/$archive" -C "$staging/extracted" \
  tsci LICENSE THIRD_PARTY_NOTICES licenses.json THIRD_PARTY_NOTICES.txt
[ -x "$staging/extracted/tsci" ] || fail "The release does not contain an executable tsci."
mkdir -p "$(dirname "$destination")"
# Recheck after downloading, and refuse to merge into an existing installation.
[ ! -e "$destination" ] && [ ! -L "$destination" ] || fail "Destination already exists: $destination"
mv "$staging/extracted" "$destination"
printf 'Installed %s for macOS %s in %s\n' "$release_tag" "$architecture" "$destination"
printf 'Run: "%s/tsci" --version\n' "$destination"
