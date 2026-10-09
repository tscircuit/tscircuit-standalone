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
the CLI's existing >98% copper IoU threshold, equal pad count, complete physical
pin mapping, and non-conflicting aliases. Pin metadata, source licensing and
rendered connectivity also need review. Entries that need exact geometry are
excluded; popularity does not waive the compactness rule.

The initial C2040 recipe comes from MIT-licensed
`tscircuit/common@a5797da88ec19944442d87392174af0a36fe1a0a`. All 57 copper pads match
the exact RP2040 comparison reference, with copper IoU 0.9981788348844475. Pin57
retains both GND and thermalpad aliases. Remote OBJ/STEP links from the source
are removed. The comparison reference is not included in the runtime bundle.
Full measurements and source links are in [CLI audit](cli-audit.md).

Catalog expansion, popularity ranking and acquisition tooling are pending.
Candidate snapshots and expanded reference geometry belong in a build-time
pipeline; the executable receives only qualified compact records. A future
manifest should record converter versions, qualification metrics, rejected
candidates and serialized size limits. The current prototype contains one part.
