#!/bin/bash
# Exercise the installed release signature without host runtimes or warm caches.
set -euo pipefail

binary="${1:?Usage: EXPECTED_VERSION=version bash scripts/smoke-macos-signed.sh path/to/tsci}"
expected_version="${EXPECTED_VERSION:?Expected the release version}"
binary="$(cd "$(dirname "$binary")" && pwd)/$(basename "$binary")"
script_dir="$(cd "$(dirname "$0")" && pwd)"
test "$(uname -s)" = Darwin
test -x "$binary"

smoke_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/tsci-signed-smoke.XXXXXX")"
trap 'rm -rf "$smoke_dir"' EXIT
mkdir -p "$smoke_dir/home" "$smoke_dir/tmp"

run_tsci() {
  # The CLI serves its baked assets over loopback. External traffic stays denied.
  /usr/bin/sandbox-exec -p '
    (version 1)
    (allow default)
    (deny network*)
    (allow network-inbound (local ip "localhost:*"))
    (allow network-outbound (remote ip "localhost:*"))
  ' /usr/bin/env -i \
    HOME="$smoke_dir/home" TMPDIR="$smoke_dir/tmp/" \
    XDG_CACHE_HOME="$smoke_dir/home/.cache" \
    XDG_CONFIG_HOME="$smoke_dir/home/.config" \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin CI=1 \
    "$binary" "$@"
}

cd "$smoke_dir"
test "$(run_tsci --version)" = "$expected_version"
run_tsci --help
run_tsci init project --yes
cd project
cp "$script_dir/../examples/led-resistor.circuit.tsx" index.circuit.tsx
cp -R "$script_dir/../examples/helpers" .
# Exercise JavaScriptCore, the embedded worker, WASM, and the native PNG renderer.
run_tsci build --ignore-errors --concurrency 2 --pcb-png
test -s dist/index/circuit.json
test -s dist/index/pcb.png
run_tsci import RP2040
test -s imports/RP2040.tsx
