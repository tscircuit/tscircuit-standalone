# Compact catalog policy

Standalone acquires the public datasheets API catalog when its UI and binary are
built. `bun run build` fetches the inventory, validates usable recipes and pin
metadata, then compiles the admitted parts into one compressed generated module.
The browser, evaluator worker and native binary embed that module. The generated
catalog is ignored by Git; there is no committed datasheet collection or catalog
manifest.

## Build and admission

The build reads `/datasheets/list` and every `/datasheets/get` result with bounded
concurrency and request deadlines. It checks that the complete inventory remains
stable, validates all responses, and logs the admitted and excluded counts. A
failed acquisition stops the build and leaves any previous generated module
intact. The catalog is written atomically after acquisition and validation.

Admission uses the installed Footprinter release from the lockfile. It requires
a local recipe, a complete mapping between its copper and physical terminals,
and supported pin attributes. Missing recipes and inconsistent mappings are
excluded. Only de-facto package conventions are accepted; coordinate pad layouts
and manufacturer profiles are excluded. Structural admission does not establish
manufacturer land-pattern accuracy. Independently reviewed parts retain separate
manufacturer-source geometry and pin audits in `tscircuit/datasheet-database`.

The generated module stores only compact part definitions: Footprinter strings,
selector labels, pin attributes, manufacturer identifiers and datasheet
references. Expanded copper, raw API descriptions, generated TSX, PDF files and
remote CAD assets are omitted. API-generated source is never executed.

`bun run build:ui` also prepares its catalog first. For source development or
unit tests without bundling the UI, run `bun run build:catalog` once. `bun run
check` builds first, then typechecks, tests and qualifies the compiled binary, so
those checks use the same generated catalog. Builds require API access; the
compiled executable, including `tsci build`, uses its embedded parts locally.

## Imports and physical identities

`tsci import <manufacturer-part-number>` and the bundled-parts UI use the embedded
part definitions. Manufacturer lookup follows the API's name normalization. The
API currently has no supplier identifiers; the existing standalone `C2040` alias
continues to select RP2040. No additional supplier numbers are invented. Unknown
parts fail locally without a remote lookup.

Core uses numeric pin keys. Numeric datasheet terminals retain their numbers;
package coordinates and named exposed pads receive numeric keys, keeping their
original physical IDs as selector aliases. Pin attributes move with their
physical terminal. Selector aliases containing punctuation receive distinct,
valid names. Export names and default filenames encode punctuation so distinct
part numbers cannot collide.

The RP2040 qualification fixture uses physical pin selectors for repeated supply
names. Its placement is adjusted for the API land pattern to keep the routed via
clear of the GPIO25 pad. The fixture qualifies runtime and footprint behavior;
full power, memory, clock and manufacturing design remains separate work.
