# Standalone search catalogs

The installer embeds gzip search snapshots at `<provider>/search-catalog.json.gz`
inside its asset directory. The standalone parent process starts local fake API
services before launching the packaged CLI, sets their `TSCIRCUIT_*` base URLs,
and stops the services after the CLI exits. Those services own decompression,
querying, and API response generation. The CLI is a normal HTTP API client and
never reads catalog files. Missing records never trigger a public fallback.
Existing baked datasheet/model responses are served by the parent too.

| Environment variable | Fake API endpoint |
| --- | --- |
| `TSCIRCUIT_JLCSEARCH_BASE_URL` | `/api/search` |
| `TSCIRCUIT_DIGIKEY_BASE_URL` | `/api/search` |
| `TSCIRCUIT_MOUSER_BASE_URL` | `/api/search` |
| `TSCIRCUIT_TI_BASE_URL` | `/api/search` |
| `TSCIRCUIT_KICAD_BASE_URL` | `/kicad_files.json` |
| `TSCIRCUIT_REGISTRY_API_URL` | POST `/packages/search` |
| `TSCIRCUIT_DATASHEET_API_BASE_URL` | `/datasheets/list`, `/datasheets/get` |

The base URLs use separate path prefixes on a loopback HTTP server. They could
also point to independent API processes without changing the CLI. Each fake
responds with the same JSON shape as its online counterpart, plus optional
subset metadata. The catalog storage format is private to the fake services.

The checked-in selection contains common JLCPCB identities, up to ten supplier
results per common part family, registry package summaries, and the KiCad footprint
filename inventory. TPS63001 and MSPM0G3507 are included in TI, DigiKey and Mouser.
The inventory is deliberately marked `coverage: "subset"`, even for KiCad: filenames
are searchable but the corresponding footprint files are not included here.

Refresh on a connected maintainer machine:

```sh
bun scripts/refresh-search-catalogs.ts
bun test tests/search-catalogs.test.ts
```

Review `data/search-catalogs/manifest.json` with the gzip changes. It records source
URLs, capture time, counts and SHA-256 hashes. Refreshes fail on HTTP errors,
malformed responses or an entirely empty provider. A failed capture retains the
previous snapshot. Regular installer builds copy and verify the committed files;
they make no new supplier search requests. The existing datasheet capture is separate.

The storage format is version 1 JSON wrapped in gzip, with `schema_version`, `source`,
`coverage`, `generated_at`, and one of `components`, `packages`, or `files`. The
JLCPCB exporter in `tscircuit/jlcsearch/standalone-jlcsearch` emits the same format.
Stock and price are values at capture time; `null` is unknown. No credentials,
raw supplier payloads, photos or large parameter objects are included.

Search discovery and offline import support are separate. EasyEDA assets, KiCad
footprints, package code and datasheets still require their own baked responses.
The CLI reports the limited catalog explicitly, and can show a browser link on an
import miss. Browser requests may be permitted in environments that block CLI
HTTP, but search must never open a browser automatically or claim that it bypasses
a firewall.

Release ordering: publish the CLI base-URL fixes first, then update this
repository's `@tscircuit/cli` dependency and lockfile before shipping. The CLI
needs environment-based TI, KiCad and registry routing; it needs no compressed
catalog support. Keep the packaging PR draft until that dependency update and
signed installer smoke tests are complete.

To test with a companion CLI checkout before that release:

```sh
TSCIRCUIT_CLI_ENTRYPOINT=/path/to/cli/cli/main.ts bun scripts/smoke-fake-parts-services.ts
```
