/**
 * Sky-brightness conversions for the Sky-lens readout (S1 PR4).
 *
 * Falchi 2016 gives MODELED artificial zenith brightness in mcd/m² (the World
 * Atlas `grayIndex`). For the Sky lens we lead with the more familiar **Bortle
 * class** + **SQM** (mag/arcsec²) instead of the raw Falchi descriptive class.
 *
 * Honesty (the V6 bar): every value here is modeled — Falchi artificial
 * brightness, plus a natural-sky floor, mapped onto the (approximate) Bortle
 * scale. Bortle↔SQM is not a bijection in the literature; the bands below are
 * the widely-cited consensus correlation, and the readout discloses the basis
 * via the HelpTooltip rather than implying a measurement.
 *
 * Pure module (no runes/DOM) so it is unit-testable and enrolled in
 * root_lib_test alongside the other src/lib/*.test.ts slices.
 */

/**
 * Natural clear-night zenith sky brightness with no light pollution
 * (~22.0 mag/arcsec²). 0.171 mcd/m² (= 1.71e-4 cd/m²) is the canonical value;
 * we add it as a floor so the darkest Falchi pixels don't imply an
 * unphysically dark sky.
 */
export const NATURAL_SKY_MCD = 0.171;

/** Luminance zero-point of the mag/arcsec² scale: L[cd/m²] = 1.08e5·10^(-0.4·S). */
const SQM_ZEROPOINT_CD = 108_000;

/** Total zenith SQM (mag/arcsec²) from Falchi artificial brightness (mcd/m²). */
export function sqmFromArtificialMcd(artificialMcd: number): number {
	const totalMcd = Math.max(0, artificialMcd) + NATURAL_SKY_MCD;
	const totalCd = totalMcd / 1000;
	return -2.5 * Math.log10(totalCd / SQM_ZEROPOINT_CD);
}

/** Approximate consensus SQM→Bortle bands (mag/arcsec², lower bound per class). */
const BORTLE_BANDS: ReadonlyArray<{ readonly minSqm: number; readonly cls: number; readonly label: string }> = [
	{ minSqm: 21.99, cls: 1, label: 'Excellent dark-sky' },
	{ minSqm: 21.89, cls: 2, label: 'Typical dark-sky' },
	{ minSqm: 21.69, cls: 3, label: 'Rural sky' },
	{ minSqm: 21.25, cls: 4, label: 'Rural/suburban' },
	{ minSqm: 20.49, cls: 5, label: 'Suburban sky' },
	{ minSqm: 19.5, cls: 6, label: 'Bright suburban' },
	{ minSqm: 18.94, cls: 7, label: 'Suburban/urban' },
	{ minSqm: 18.38, cls: 8, label: 'City sky' },
];

/** Map an SQM value to its Bortle class (1–9) + a short descriptive label. */
export function bortleFromSqm(sqm: number): { readonly cls: number; readonly label: string } {
	for (const b of BORTLE_BANDS) {
		if (sqm >= b.minSqm) return { cls: b.cls, label: b.label };
	}
	return { cls: 9, label: 'Inner-city sky' };
}

export interface BortleReading {
	/** Bortle class, 1 (pristine) … 9 (inner city). */
	readonly cls: number;
	/** Short descriptive label for the class. */
	readonly label: string;
	/** Modeled total-sky SQM, mag/arcsec². */
	readonly sqm: number;
}

/** Convenience: Falchi artificial brightness (mcd/m²) → Bortle class + SQM. */
export function bortleFromArtificialMcd(artificialMcd: number): BortleReading {
	const sqm = sqmFromArtificialMcd(artificialMcd);
	const { cls, label } = bortleFromSqm(sqm);
	return { cls, label, sqm };
}
