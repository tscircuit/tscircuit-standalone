# Standalone search catalogs

The installer embeds gzip search snapshots at `<provider>/search-catalog.json.gz`
inside its baked asset directory. The shared CLI serves arbitrary search queries
from these records on loopback; it does not forward a missing result to a public
provider. Existing baked datasheet responses continue to work unchanged.

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

The wire format is version 1 JSON wrapped in gzip, with `schema_version`, `source`,
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

Release ordering: publish the CLI compressed-catalog handler first, then update
this repository's `@tscircuit/cli` dependency and lockfile before shipping the
installer. Older CLI versions only understand exact URL responses and cannot
search these snapshots. Keep the packaging PR draft until that dependency update
and the signed installer smoke tests are complete.
