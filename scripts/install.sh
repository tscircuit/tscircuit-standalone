#!/bin/sh
# Shared entry point for the native macOS and Linux installers.
set -eu
case "$(uname -s)" in
  Darwin) script=install-macos.sh ;;
  Linux) script=install-linux.sh ;;
  *) printf '%s\n' 'Use install-windows.ps1 from PowerShell on Windows.' >&2; exit 1 ;;
esac
staging=$(mktemp -d "${TMPDIR:-/tmp}/tsci-bootstrap.XXXXXXXX")
trap 'rm -rf "$staging"' 0
trap 'exit 1' HUP INT TERM
curl --fail --location --silent --show-error --connect-timeout 15 --max-time 60 --retry 3 \
  "https://raw.githubusercontent.com/tscircuit/tscircuit-standalone/main/scripts/$script" -o "$staging/install.sh"
sh "$staging/install.sh" "$@"
