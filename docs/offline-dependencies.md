# Explicit Bun runtime and native offline cache

Standalone uses its embedded Bun 1.4.4 runtime and Bun's native package cache.
It sets `TSCIRCUIT_NODE_RUNTIME` to its own executable path. The shared CLI uses
that executable directly, with argv and child-only `BUN_BE_BUN=1`, for package
operations. It does not create a `bun` alias, copy the executable, change PATH,
or change `npm_config_user_agent`.

`TSCIRCUIT_NODE_RUNTIME_ARGS` supplies `--config` pointing to a private bunfig in
the CLI's temporary directory. The config sets `install.offline = true`,
`install.ignoreScripts = true`, and the restored native cache directory. Bun
handles resolution, installation, lockfiles and removal. These settings do not
change the user's project/global bunfig or independently invoked system Bun.

## Companion CLI release

This revision depends on [CLI PR #5671](https://github.com/tscircuit/cli/pull/5671).
The shared CLI must support explicit runtime selection before standalone's
`@tscircuit/cli` dependency is upgraded. The current published dependency pin
predates that support, so the standalone PR remains draft. Compilation rejects
an older CLI rather than producing a binary that falls back to a system manager.
The combined executable is tested locally with the companion CLI build; a
published CLI version must be pinned before release and native-platform CI.

The CLI contract is a Bun-compatible executable plus optional JSON argv. It has
no knowledge of standalone's cache transport, archive, or offline policy. With
an explicit runtime available, standalone init installs dependencies by default;
`--no-install` still skips installation.

## Preparing and restoring the cache

Build and test jobs pin Bun 1.4.4, the latest stable release verified on
2026-11-03. `.bun-version` records the local version and the vendored Bun notices
cover this runtime. Strict offline installation requires Bun 1.4.1 or newer;
`--prefer-offline` alone permits downloads on cache misses.

`scripts/build-bun-cache.ts` warms an isolated native cache for the CLI's init
requirements and the selected runtime release, including all OS/CPU optional
packages. Lifecycle scripts are disabled. Seed lockfiles, package notices and
the prepared archive are retained as build inputs and shared across targets.
Cached `latest` tags are snapshots at preparation time and can differ from a
manually selected older runtime release. Retain the archive and seed lockfiles
for exact reproduction; rebuilding can select newer tags or transitive versions.

Package files and binary registry manifests retain their native contents.
Transport metadata preserves executable modes and relocates cache index links;
Windows restores directory links as junctions. Canonical paths handle macOS temp
directory aliases and Windows junctions without admitting links outside the cache.

The cache is restored once into a versioned, archive-specific user cache directory,
using staged extraction and an atomic rename. `TSCIRCUIT_CACHE_DIR` overrides its
root. The first standalone invocation prepares this cache; subsequent invocations
reuse it. Each process writes a private bunfig alongside its temporary assets,
then removes that configuration on exit. Existing cache snapshots can be reused
without depending on old launcher files or runtime config stored in the cache.

## Behavior and limits

Missing packages, unavailable versions, and uncached tarball/Git URLs fail locally
through Bun. Project .npmrc registry settings are respected; absent metadata produces
an offline miss. Lifecycle scripts are disabled because they can access the
network independently. Removing a damaged versioned cache directory restores it
on the next standalone invocation.

Existing switches disable update checks, telemetry, account fetches and skill
downloads. Other features and arbitrary user code are not sandboxed. The runtime
hook selects an executable; it does not restrict all of Bun's commands.

The build uses published `altiumts@0.0.59` (also used by the UI), avoiding the Git
package's missing build outputs with the isolated linker, and bundles the computed
autorouter runtime import needed by compiled circuit builds.

## Qualification

`tests/native-bun.test.ts` compiles a fixture executable, restores a real native
cache and invokes that executable with `BUN_BE_BUN=1`. It verifies unchanged PATH
and user agent, cached install/add/remove, misses, script suppression, and native
config precedence over a project bunfig that enables networking. Offline
operations make zero fixture-registry requests.

The companion CLI tests exercise the actual runtime hook with a compiled Bun
application, an empty PATH, executable paths containing spaces/metacharacters,
literal argument forwarding, and failure without fallback. They run in Linux
and Windows CI.

`scripts/smoke-offline-install.ts` tests the actual standalone executable with
no package manager on PATH: init, reinstall, add, cache misses, and absence of
private launcher files. Linux traces reject non-loopback connection/send attempts.
Existing compiled build, browser, native macOS/Windows and installer qualification
remains enabled once the companion CLI release is pinned.
