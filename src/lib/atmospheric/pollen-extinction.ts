/**
 * Pollen optical depth — a geometric-optics estimate of how much the airborne
 * pollen load attenuates a beam (V3-9). INFORMATIONAL only: it answers "does
 * pollen matter for my link?" and the answer is essentially always "no".
 *
 * Pollen grains are large (~20–35 µm) relative to visible/IR wavelengths, so
 * they're geometric-optics scatterers with extinction efficiency Q_ext ≈ 2. The
 * column optical depth from a number concentration N (grains/m³) over an
 * effective near-surface layer of depth H is:
 *
 *   τ = Σ_species  N · Q_ext · π·r²  · H
 *
 * Even at extreme counts this lands around 1e-4–1e-3 — two to three orders of
 * magnitude below typical aerosol AOD (~0.1–0.2). So this is surfaced as context,
 * NOT folded into the transmission AOD (that would imply a materiality the
 * physics doesn't support). There is no validated concentration→extinction model;
 * the per-species radii below are representative palynological means and the
 * result is order-of-magnitude. Pure, dependency-free.
 */

import { POLLEN_SPECIES, type PollenReading } from '$lib/effect/services/AirQualityService';

/** Representative effective grain radius (µm) per species (≈ half typical grain diameter). */
const GRAIN_RADIUS_UM: Record<keyof PollenReading, number> = {
	alder: 12.5,
	birch: 11,
	grass: 16,
	mugwort: 11,
	olive: 11,
	ragweed: 10,
};

const Q_EXT = 2; // geometric-optics extinction efficiency (grain ≫ wavelength)
const DEFAULT_LAYER_DEPTH_M = 1000; // assumed near-surface pollen mixing depth
/** Below this the contribution is imperceptible against typical aerosol AOD. */
const NEGLIGIBLE_BELOW = 0.01;

export interface PollenOpticalDepth {
	/** Total column optical depth contribution (dimensionless). */
	readonly tau: number;
	/** True when τ is far below typical aerosol AOD — i.e. it does not matter. */
	readonly negligible: boolean;
}

/**
 * Column optical depth from the pollen load. `null`/zero species contribute
 * nothing. `layerDepthM` is the assumed near-surface pollen layer (default 1 km).
 */
export const pollenOpticalDepth = (
	pollen: PollenReading,
	opts: { readonly layerDepthM?: number } = {},
): PollenOpticalDepth => {
	const H = opts.layerDepthM ?? DEFAULT_LAYER_DEPTH_M;
	let tau = 0;
	for (const sp of POLLEN_SPECIES) {
		const n = pollen[sp];
		if (n === null || !(n > 0)) continue;
		const r = GRAIN_RADIUS_UM[sp] * 1e-6; // µm → m
		const beta = n * Q_EXT * Math.PI * r * r; // extinction coefficient, 1/m
		tau += beta * H;
	}
	return { tau, negligible: tau < NEGLIGIBLE_BELOW };
};
