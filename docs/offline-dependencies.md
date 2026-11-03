# Native Bun cache and offline installation

Standalone uses Bun 1.4.4's package manager and native cache. The shared CLI is
unchanged: its normal `bun install`, `bun add`, and `bun remove` subprocesses find
a private launcher on PATH. That launcher is a hardlink (or a cached copy) of the
standalone executable, named `bun` / `bun.exe`. It re-enters the embedded runtime
with `BUN_BE_BUN=1`, enforcing `--offline --ignore-scripts`. It does not implement
package resolution, installation, dependency validation, or project scaffolding.

All build and test jobs pin Bun 1.4.4, the latest stable release verified on
2026-11-03. `.bun-version` records the local build version. The existing vendored
1.4.4 runtime license metadata is reused. Strict install `--offline` requires
Bun 1.4.1 or newer; `--prefer-offline` alone permits downloads on cache misses.
The `altiumts` override selects the published 0.0.59 package already used by the
UI, avoiding the Git package's missing build output in the newer isolated linker.

## Preparing the native cache

`scripts/build-bun-cache.ts` uses the pinned Bun to warm an isolated cache during
release preparation. It installs the default init requirements (`tscircuit` and
React types at `latest`, TypeScript at `^5`) and the explicitly selected runtime
release. All OS/CPU optional packages are requested. Lifecycle scripts are never
run. It records each seed project's Bun lockfile for review/reproduction.

The archive contains native package directories and binary registry manifests,
without changing their contents. Cache index links are made relative for
portability. Small transport metadata preserves executable modes and links;
Windows restores directory links as junctions and file links as copies, without
requiring developer mode. Distribution notices include the cached packages.
The prepared archive and manifests are shared across all five target builds.

The captured `latest` tag is the registry snapshot at cache preparation time;
it may differ from a manually selected older runtime release. Both are cached.
The embedded circuit engine remains the standalone release's selected version.
A later clean preparation can resolve newer transitive versions or tags: retain
the prepared archive and seed lockfiles for an exact release record. This cache
is a release snapshot, not an online update channel.

## Running offline

The cache is restored lazily on the first package operation into a versioned,
archive-specific user cache directory. Extraction is staged and renamed; concurrent
processes can reuse the winning completed extraction. Later commands reuse it.
`TSCIRCUIT_CACHE_DIR` overrides the default user cache root. Private launcher copies
are also cached so a cross-filesystem copy is not repeated on every command.
Neither Bun nor npm needs to be installed separately or exposed on the user's PATH.

Missing packages, unavailable versions, uncached URLs and Git dependencies fail
locally through Bun. Lifecycle scripts are disabled because they can make their
own network calls even when the package manager is offline. There is no fallback
to a system package manager. Project registry settings remain respected; if their
registry metadata is absent from the bundled cache, installation fails locally.

Cache files remain writable for Bun. If a user removes a required entry, Bun
reports an offline cache miss. Removing the affected versioned cache directory
causes standalone to restore it on the next package operation. Package files in
projects are managed entirely by Bun, including its normal lockfile and cache
linking behavior.

The existing launcher switches still disable update checks, telemetry, account
fetches and skill downloads. This feature covers init/install/add/remove and
package updates. It does not make all circuit-build features offline, intercept
separately invoked system Bun/npm, or sandbox arbitrary user code. Other Bun
commands are unavailable through the private launcher.

## Qualification

`tests/native-bun.test.ts` builds a real compiled launcher and a small native cache
using a loopback fixture registry. It checks discovery with an empty PATH, native
install/add/remove, cache misses, URL rejection, script suppression and policy
flags, and verifies that offline operations make zero fixture-registry requests.
It runs on Linux, macOS and Windows CI.

`scripts/smoke-offline-install.ts` tests the actual distributed executable: default
init, reinstall after deleting node_modules, package addition, and cache misses,
with no package manager on PATH. Linux CI runs it in a network namespace with only
loopback available and uses strace to reject non-loopback connect/send attempts.
The trace permits the CLI's baked-asset loopback listener and Unix stream sockets
used for subprocess output. macOS and Windows CI run the native executable smoke
without Linux syscall tracing. Existing compiled build/browser qualification is
retained.
