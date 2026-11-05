#!/bin/sh
# Install a checksum-verified Linux release, preserving its redistribution notices.
set -eu
umask 022
fail() { printf '%s\n' "$*" >&2; exit 1; }
[ "$#" -le 2 ] || fail 'Usage: sh install-linux.sh [RELEASE_TAG|latest] [DESTINATION]'
[ "$(uname -s)" = Linux ] || fail 'This installer is for Linux.'
case "$(uname -m)" in
  x86_64|amd64) architecture=x64 ;;
  aarch64|arm64) architecture=arm64 ;;
  *) fail "Unsupported Linux architecture: $(uname -m)" ;;
esac
validate_tag() {
  case "$1" in
    ''|*[!a-zA-Z0-9._-]*|[!a-zA-Z0-9]*) fail 'Invalid release tag' ;;
  esac
}
release_tag=${1-latest}
validate_tag "$release_tag"
destination=${2-}
prefix=${TSCI_INSTALL_PREFIX:-${HOME:?HOME is required}/.local}
if [ -z "$destination" ] && [ -z "${TSCI_INSTALL_PREFIX:-}" ] && [ -t 1 ] && [ "${TSCI_NONINTERACTIVE:-0}" != 1 ]; then
  # Read from the terminal, since stdin may contain the curl | sh script.
  if ( : <>/dev/tty ) 2>/dev/null; then
    printf 'Installation prefix [%s]: ' "$prefix" >/dev/tty
    IFS= read -r selected_prefix </dev/tty || fail 'Destination selection cancelled.'
    prefix=${selected_prefix:-$prefix}
  fi
fi
case "$prefix" in /*) ;; *) fail 'TSCI_INSTALL_PREFIX must be an absolute path' ;; esac
prefix=${prefix%/}
check_writable() {
  writable=$1
  while [ ! -e "$writable" ]; do writable=$(dirname "$writable"); done
  [ -d "$writable" ] && [ -w "$writable" ] && [ -x "$writable" ] ||
    fail "Cannot write to $1. Choose a writable destination; this installer does not request administrator access."
}
bundle_root=$prefix/lib/tscircuit-standalone
command_path=$prefix/bin/tsci
previous=
check_command_path() {
  resolved_command=$(command -v tsci || true)
  if [ -n "$resolved_command" ] && [ "$resolved_command" != "$command_path" ]; then
    fail "An existing tsci command is on PATH at $resolved_command; use a portable destination or remove the conflict first."
  fi
}
if [ -n "$destination" ]; then
  case "$destination" in /*) ;; *) destination=./$destination ;; esac
  [ ! -e "$destination" ] && [ ! -L "$destination" ] || fail "Destination already exists: $destination"
  check_writable "$(dirname "$destination")"
else
  check_writable "$bundle_root"
  check_writable "$prefix/bin"
  check_command_path
  if [ -e "$command_path" ] || [ -L "$command_path" ]; then
    target=$(readlink "$command_path" 2>/dev/null || true)
    case "$target" in
      "$bundle_root"/install.*/tsci) previous=${target%/tsci} ;;
      *) fail "An existing tsci command is installed at $command_path; refusing to replace it." ;;
    esac
    [ -f "$previous/.tscircuit-installer" ] && [ ! -L "$previous/.tscircuit-installer" ] && [ ! -d "$command_path" ] &&
      grep -Fxq 'tscircuit-standalone' "$previous/.tscircuit-installer" || fail 'Existing installation is not managed by this installer.'
  fi
fi
for tool in curl tar mktemp; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required command not found: $tool"
done
if command -v sha256sum >/dev/null 2>&1; then checksum=sha256sum
elif command -v shasum >/dev/null 2>&1; then checksum=shasum
else fail 'sha256sum or shasum is required'; fi
staging=$(mktemp -d "${TMPDIR:-/tmp}/tsci-install.XXXXXXXX")
incoming=
link_dir=
cleanup() {
  rm -rf "$staging"
  if [ -n "$incoming" ]; then rm -rf "$incoming"; fi
  if [ -n "$link_dir" ]; then rm -rf "$link_dir"; fi
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

if [ "$release_tag" = latest ]; then
  # GitHub's /releases/latest endpoint excludes the project's prereleases.
  if command -v jq >/dev/null 2>&1; then parser=jq
  elif command -v python3 >/dev/null 2>&1; then parser=python3
  else fail 'Install jq or Python 3 to select latest, or pass an explicit release tag.'; fi
  curl --fail --location --silent --show-error --connect-timeout 15 --max-time 60 --retry 3 \
    'https://api.github.com/repos/tscircuit/tscircuit-standalone/releases?per_page=1' -o "$staging/releases.json"
  if [ "$parser" = jq ]; then
    release_tag=$(jq -er 'if type == "array" and length > 0 and .[0].draft == false and (.[0].tag_name | type == "string") then .[0].tag_name else error("No published release") end' "$staging/releases.json") || fail 'Could not determine the latest published release.'
  else
    release_tag=$(python3 - "$staging/releases.json" <<'PY'
import json, sys
with open(sys.argv[1]) as source:
    releases = json.load(source)
if not isinstance(releases, list) or not releases or releases[0].get('draft') is not False or not isinstance(releases[0].get('tag_name'), str):
    raise SystemExit('No published release')
print(releases[0]['tag_name'])
PY
    ) || fail 'Could not determine the latest published release.'
  fi
  validate_tag "$release_tag"
fi
archive=tscircuit-standalone-linux-$architecture.tar.gz
base=https://github.com/tscircuit/tscircuit-standalone/releases/download/$release_tag
for asset in "$archive" SHA256SUMS; do
  curl --fail --location --silent --show-error --connect-timeout 15 --max-time 300 --retry 3 \
    "$base/$asset" -o "$staging/$asset"
done
awk -v name="$archive" '$2 == name { print; count++ } END { if (count != 1) exit 1 }' \
  "$staging/SHA256SUMS" > "$staging/selected-checksum" || fail 'Missing or duplicate archive checksum.'
if [ "$checksum" = sha256sum ]; then
  (cd "$staging" && sha256sum --check selected-checksum) || fail 'Archive checksum verification failed.'
else
  (cd "$staging" && shasum -a 256 --check selected-checksum) || fail 'Archive checksum verification failed.'
fi
mkdir "$staging/extracted"
tar -xzf "$staging/$archive" -C "$staging/extracted" tsci LICENSE THIRD_PARTY_NOTICES licenses.json THIRD_PARTY_NOTICES.txt
for file in tsci LICENSE THIRD_PARTY_NOTICES licenses.json THIRD_PARTY_NOTICES.txt; do
  [ -s "$staging/extracted/$file" ] && [ ! -L "$staging/extracted/$file" ] || fail "Invalid release file: $file"
done
[ -x "$staging/extracted/tsci" ] || fail 'The release does not contain an executable tsci.'
"$staging/extracted/tsci" --version >/dev/null || fail 'The downloaded binary cannot run on this Linux system.'
if [ -n "$destination" ]; then
  mkdir -p "$(dirname "$destination")"
  [ ! -e "$destination" ] && [ ! -L "$destination" ] || fail "Destination already exists: $destination"
  mv "$staging/extracted" "$destination"
  printf 'Installed %s. Run: "%s/tsci" --version\n' "$release_tag" "$destination"
  exit 0
fi
# Install using only the current user's permissions.
mkdir -p "$bundle_root" "$prefix/bin"
incoming=$(mktemp -d "$bundle_root/install.XXXXXXXX")
cp "$staging/extracted/"* "$incoming/"
chmod 755 "$incoming" "$incoming/tsci"
chmod 644 "$incoming/LICENSE" "$incoming/THIRD_PARTY_NOTICES" "$incoming/licenses.json" "$incoming/THIRD_PARTY_NOTICES.txt"
printf '%s\n' 'tscircuit-standalone' > "$staging/.tscircuit-installer"
cp "$staging/.tscircuit-installer" "$incoming/"
link_dir=$(mktemp -d "$prefix/bin/.tsci-link.XXXXXXXX")
ln -s "$incoming/tsci" "$link_dir/tsci"
check_command_path
if [ -n "$previous" ]; then
  [ -L "$command_path" ] && [ "$(readlink "$command_path")" = "$target" ] || fail 'The installed command changed while downloading.'
  mv -f "$link_dir/tsci" "$command_path"
else
  # Creating without --force also protects a command installed during the download.
  ln -s "$incoming/tsci" "$command_path"
fi
incoming=
if [ -n "$previous" ]; then rm -rf "$previous"; fi
case ":$PATH:" in
  *":$prefix/bin:"*) printf 'Installed %s. Run: tsci --version\n' "$release_tag" ;;
  *) printf 'Installed %s. Run: "%s" --version\n' "$release_tag" "$command_path" ;;
esac
