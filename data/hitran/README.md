# HITRAN line-data cache

This directory holds **curated subsets** of HITRAN2020 line lists for the named atmospheric absorption bands V3b targets. The full HITRAN catalog is gated behind free registration at <https://hitran.org/>; we ship a hand-curated representative subset here so the LBL service (V3b-3) and Voigt bake (V3b-2) work out of the box, and document how to regenerate the full data offline.

## Files

- `curated-lines.json` — committed subset, ~20 strongest lines per band, sufficient for the V3b widget detail chart to render.

## Schema

See `src/lib/spectral/hitran-bands.ts`:

```ts
interface CuratedHitranArchive {
  version: number;
  note: string;
  attribution: string;
  bands: {
    bandId: string;     // HITRAN_BANDS.id
    molecule: 'h2o' | 'o2' | 'co2';
    source: string;     // origin tag (curated-v1 | hitran-online-{snapshot})
    fetchedAt: string;  // ISO timestamp
    lines: {
      nu0: number;      // cm⁻¹
      S: number;        // cm⁻¹/(molecule·cm⁻²) at T_ref = 296 K
      gammaAir: number; // cm⁻¹/atm
      gammaSelf: number;// cm⁻¹/atm
      Elower: number;   // cm⁻¹
      nAir: number;     // dimensionless
    }[];
  }[];
}
```

## Regenerating with the full HITRAN catalog

The committed `curated-lines.json` is a representative subset, not the full
catalog. To regenerate with the complete line list:

1. Create an account at <https://hitran.org/> (free).
2. Use the HITRANonline web search interface or the
   [hapi](https://hitran.org/hapi/) Python package to download line lists for:
   - H₂O around 940 / 1130 / 1380 / 1870 nm windows (`molecule_id=1`, `iso_id=1`)
   - O₂ around 762 nm (A-band) and 628 nm (γ-band) (`molecule_id=7`)
   - CO₂ around 4.3 µm (ν₃ band) (`molecule_id=2`, `iso_id=1`)
3. Convert each .par output to the schema above and drop it into
   `curated-lines.json`. The `source` field should be set to
   `hitran-online-{YYYY-MM-DD}` to track provenance.

V3b-2's bake script (`scripts/bake-spectral-lbl.ts`) consumes whatever lines
are in `curated-lines.json` — adding more lines simply improves Voigt
resolution at the band centers and wings.

## Attribution

> Gordon, I.E., L.S. Rothman, R.J. Hargreaves, et al. (2022)
> *The HITRAN2020 molecular spectroscopic database.*
> Journal of Quantitative Spectroscopy and Radiative Transfer 277, 107949.
> <https://doi.org/10.1016/j.jqsrt.2021.107949>

The HITRAN database is freely available to registered users under the HITRAN
team's terms of use. The line subset committed here is a derivative work
falling under fair use for the purposes of this open-source tool; for any
redistribution of larger HITRAN data subsets, users must register at
hitran.org and accept the database's own terms.
