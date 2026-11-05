#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f package.json || ! -f bun.lock || $# -gt 1 ]]; then
  echo 'Run from the repository root, with an optional tscircuit version.' >&2
  exit 2
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=\"$script_dir/ci-https-agent.cjs\""
command=(bun install --frozen-lockfile)
if [[ $# -eq 1 ]]; then
  command=(bun scripts/prepare-release.ts "$1")
fi
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

for attempt in 1 2 3; do
  if "${command[@]}" 2>&1 | tee "$log"; then
    exit 0
  else
    statuses=("${PIPESTATUS[@]}")
    status="${statuses[0]}"
    if [[ "$status" -eq 0 ]]; then status="${statuses[1]}"; fi
  fi
  if [[ "$attempt" -eq 3 ]] || ! grep -Eq \
    'Request timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|HTTP 5[0-9][0-9]|prebuild-install warn install No prebuilt binaries found' "$log"; then
    exit "$status"
  fi
  echo "Dependency download failed; retrying with fresh node_modules (attempt $((attempt + 1))/3)."
  # Bun can otherwise consider a failed native lifecycle script installed on
  # the next attempt. Keep downloaded package caches, but re-run installation.
  rm -rf -- node_modules ui/node_modules
  sleep 2
done
