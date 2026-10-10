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
3.3 V and 2.8 V regulators, a 40 MHz crystal, and a JST power connector. A 1.2 V
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

USB-C and camera FFC candidates need explicit shell numbering and reversed
contact numbering in footprinter before admission; matching geometry alone is
insufficient. Popularity ranking and broader acquisition automation remain pending.
