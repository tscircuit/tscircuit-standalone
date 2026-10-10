# Compact catalog policy

A bundled component must have a local footprinter recipe, a complete mapping
from copper pads to physical pin labels, supplier/manufacturer identity, and
source provenance. Runtime records contain no expanded footprint geometry,
remote CAD assets, raw EasyEDA payloads, or acquisition API dependencies.

The current validator generates copper from the recipe, verifies that each pad
maps to exactly one labeled pin and every pin maps to copper, rejects duplicate
supplier IDs and unsupported fields, and freezes the validated records. Catalog
serialization is deterministic. This structural validator does not replace
comparison against the original land pattern.

New entries require build-time qualification against reference geometry using
the CLI's existing >98% copper IoU threshold, >98% hole IoU, equal pad count,
complete physical pin mapping, and non-conflicting aliases. Pin metadata, source licensing and
rendered connectivity also need review. Entries that need exact geometry are
excluded; popularity does not waive the compactness rule.

The initial C2040 recipe comes from MIT-licensed
`tscircuit/common@a5797da88ec19944442d87392174af0a36fe1a0a`. All 57 copper pads match
the exact RP2040 comparison reference, with copper IoU 0.9981788348844475. Pin57
retains both GND and thermalpad aliases. Remote OBJ/STEP links from the source
are removed. The comparison reference is not included in the runtime bundle.
Full measurements and source links are in [CLI audit](cli-audit.md).

The camera candidates add a bare ESP32-S3R8, 16 MB SPI flash, USB ESD protection,
3.3 V, 2.8 V and 1.3 V regulators, a 40 MHz crystal, USB-C, camera FFC,
JST power and U.FL antenna connectors. These are eleven distinct camera imports. A 1.2 V
regulator is also qualified; it is not suitable for the OV2640's 1.3 V core rail.
The ESP32-S3R8's 8 MB PSRAM is inside the chip package; this entry is a QFN chip,
not a radio module. The runtime stores recipes and pin labels in
[camera-parts.ts](../lib/camera-parts.ts), with native crystal/connector properties
and documented internal connections where needed. Remote CAD assets remain excluded.

Adapted component source retains the pinned `tscircuit/common` MIT provenance.
New manufacturer-fact records identify the public datasheet and supplier
reference without claiming an upstream source-code license. These records are
authored independently; no implementation from an unlicensed component repository
is copied. References from the JLCEDA/EasyEDA Official Library retain attribution
and the official links in generated source and third-party notices.

[Qualification results](camera-catalog-qualification.json) record all pad counts,
copper/hole IoU, pin parity, compact record sizes, reference SHA-256 digests and
the installed footprinter/comparison package versions. These checks qualify the
land pattern, not a complete circuit, RF design or manufacturing release. Board
qualification must still inspect rendered connectivity, routing and placement
errors. In particular, thermal vias need ground ownership in the circuit renderer.

Repeat comparison using `bun scripts/qualify-catalog.ts manifest.json report.json`.
The local manifest has a `parts` array; each item supplies the proposed `part`
record, a local `referenceFile` containing reference Circuit JSON, and its
`referenceSha256`. Relative reference paths resolve from the manifest directory.
The tool refuses changed reference bytes, pad-count differences, pin mismatches,
and copper/hole IoU at or below 98%. It uses a build-only dependency and never
fetches acquisition data. Keep expanded references and acquisition payloads out
of the runtime catalog.

The USB-C recipe preserves supplier shell pins 13/14 and contacts 15–26.
The FFC recipe preserves right-to-left physical contacts 1–24, with mounts 25/26.
The U.FL recipe retains supplier ground pins 1/3 and signal pin 2, with its
copper bounds centered on the component datum. USB-C retains supplier EH/Dn
labels alongside SHELL/DM aliases used by the native schematic symbol. These need the
additive Footprinter families in [PR #910](https://github.com/tscircuit/footprinter/pull/910)
and [PR #911](https://github.com/tscircuit/footprinter/pull/911). The temporary,
locally bundled package is pinned throughout the dependency graph; its exact
source, archive digest and ISC license are recorded in
[vendor/footprinter.json](../vendor/footprinter.json). Replace this artifact with
the approved published version after upstream review.

Core 0.0.2116, currently pinned here, leaves the USB-C shared shell plated holes
without PCB terminal ownership. The native import test covers USB-C source pins
and SMT contact ownership, plus FFC/U.FL copper numbering; it does not assert
that shell ownership is correct on this Core version. Full board qualification
requires Core fixes for repeated physical shell terminals and thermal-via
ownership, including
[PR #4487](https://github.com/tscircuit/core/pull/4487), and must verify every shell
hole and thermal via has its intended electrical owner. Adding canonical
schematic aliases does not fix repeated PCB terminal ownership. These renderer fixes
are a separate dependency change in the board preparation PR.

Popularity ranking and broader acquisition automation remain pending.
