# Offline init and install

The standalone build now prepares an installable dependency archive in addition
to its runtime/browser bundles. `scripts/build-dependency-bundle.ts` creates an
isolated starter project with the exact installed versions of tscircuit,
TypeScript, React and React types, resolves a hoisted tree on the release builder,
and packages it with per-file hashes and its Bun lockfile. All OS/CPU optional
packages are requested so cross-compilation does not ship only the build host's
native dependencies. Lifecycle scripts are disabled.

The build must use a shared CLI version containing the
`TSCIRCUIT_DEPENDENCY_BUNDLE` backend. **The currently pinned published CLI does
not contain this change.** Land/release the companion CLI change first, then
update `@tscircuit/cli` and `bun.lock` here. Compilation deliberately rejects the
old CLI instead of producing an executable that still invokes Bun/npm.

The archive and generated import are prepared once and shared with every target
build. Startup passes the embedded archive path to the CLI; only init/install read its
bytes. The CLI installs into
project-local `node_modules`, so dependencies remain usable after the process's
temporary directory is removed. Runtime installation does not execute package
scripts, contact registries, or discover a system package manager. The release
license inventory includes packages inside the archive as well as compiler inputs.

Behavior and archive format are documented in the companion CLI's
`docs/standalone-dependencies.md`. Missing packages/versions fail locally; the
initial backend installs the whole release tree and supports only that resolved
graph. Existing unmanaged `node_modules` must be moved aside by the user.

## Qualification and cost

Local prototype measurement using tscircuit 0.0.3031-libonly, TypeScript 5.9.3,
React 19.3.1 and React types 19.3.0: 293 top-level packages, 19,279 regular files,
25 executable links, and a 190,070,183-byte ZIP (about 181 MiB). This is additional
payload beyond the compiled runtime. Exact size and package graph depend on the
selected release. A separate enterprise dependency pack or a narrower types-only
SDK would reduce the base installer size but would change the installation
contract; this implementation bundles the complete installable tree.

The first preparation resolves transitive version ranges; the resulting lockfile
and archive freeze that resolution for all platform artifacts in that release.
A later clean preparation may select different transitive versions. For exact
rebuilds, retain the prepared project lockfile and use a frozen install against it.
Compare the prepared engine graph to the runtime graph during release qualification.

Before release, qualify the compiled binary on supported native platforms, with
empty caches, no package manager on PATH, and outbound networking denied and
monitored. Run init, reinstall after deleting node_modules, supported package
addition, missing package/version rejection, and starter build. Include interactive
init (update-check path), corrupt archive recovery and Windows executable shims.
Packages needing lifecycle scripts must be qualified or excluded explicitly;
this backend never runs those scripts. Executing a Node tool from node_modules
still requires Node even though tsci itself is a standalone executable.

Source-CLI tests with fetch recording and empty PATH are useful regression checks,
but do not replace OS-level DNS/socket monitoring or native binary qualification.
Directly invoked Bun/npm commands remain outside tsci's control.
