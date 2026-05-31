/**
 * V3b — named atmospheric absorption bands targeted by line-by-line
 * Voigt-profile computation. Each entry pins one HITRAN molecule + a
 * wavelength window the LBL service (V3b-3) supplies in lieu of the
 * coarse LUT cell when the user zooms into a specific astronomy band.
 *
 * The bands here are the ones the original user story called out:
 * water-vapor NIR / SWIR windows for ground-based imaging, O₂ A-band
 * for telluric subtraction in spectroscopy, telluric O₂-X (γ band) for
 * red-end calibration, CO₂ ν₃ at 4.3 µm for thermal IR planning.
 *
 * Line data is fetched offline from HITRANonline (https://hitran.org/lbl/)
 * and baked into `data/hitran/curated-lines.json` by V3b-2's bake
 * script. The shape is intentionally minimal — just what the Voigt
 * evaluator needs.
 *
 * Attribution: HITRAN2020 (Gordon et al. 2022, JQSRT 277, 107949).
 * Public-domain access via hitran.org with free registration.
 */

export type HitranMolecule = 'h2o' | 'o2' | 'co2';

export interface HitranBand {
	readonly id: string;
	readonly label: string;
	readonly molecule: HitranMolecule;
	/** Wavelength window center [µm]. */
	readonly centerUm: number;
	/** Half-width of the window [µm]. The LBL service covers ±halfWidthUm around the center. */
	readonly halfWidthUm: number;
	/** Why this band matters — surfaced as a tooltip in the V3b-4 detail chart. */
	readonly description: string;
}

export const HITRAN_BANDS: ReadonlyArray<HitranBand> = [
	{
		id: 'h2o-940nm',
		label: 'H₂O ρστ (940 nm)',
		molecule: 'h2o',
		centerUm: 0.94,
		halfWidthUm: 0.04,
		description: 'Strong water-vapor NIR band; pairs with the 0.94 µm SWIR window for column-PWV retrievals.',
	},
	{
		id: 'h2o-1130nm',
		label: 'H₂O Φ (1130 nm)',
		molecule: 'h2o',
		centerUm: 1.13,
		halfWidthUm: 0.04,
		description: 'Moderate water-vapor band — useful intermediate between the 940 and 1380 nm bands.',
	},
	{
		id: 'h2o-1380nm',
		label: 'H₂O ψ (1380 nm)',
		molecule: 'h2o',
		centerUm: 1.38,
		halfWidthUm: 0.05,
		description: 'Deep water-vapor band; "opaque under moderate PWV" — used as a cirrus indicator.',
	},
	{
		id: 'h2o-1870nm',
		label: 'H₂O Ω (1870 nm)',
		molecule: 'h2o',
		centerUm: 1.87,
		halfWidthUm: 0.07,
		description: 'Strong SWIR water-vapor band; saturates at high PWV. Drives MODIS PWV retrieval.',
	},
	{
		id: 'o2-a-band-762nm',
		label: 'O₂ A-band (762 nm)',
		molecule: 'o2',
		centerUm: 0.762,
		halfWidthUm: 0.012,
		description: 'O₂ B³Σ ← X³Σ transition; precision-photometry reference for telluric calibration.',
	},
	{
		id: 'o2-x-band-628nm',
		label: 'Telluric O₂-X (628 nm)',
		molecule: 'o2',
		centerUm: 0.628,
		halfWidthUm: 0.008,
		description: 'Weaker O₂ γ-band; red-end spectroscopic telluric reference.',
	},
	{
		id: 'co2-43um',
		label: 'CO₂ ν₃ (4.3 µm)',
		molecule: 'co2',
		centerUm: 4.3,
		halfWidthUm: 0.15,
		description: 'CO₂ asymmetric-stretch fundamental; saturated under any atmospheric column.',
	},
];

export const HITRAN_BAND_IDS: ReadonlyArray<string> = HITRAN_BANDS.map((b) => b.id);

export const findHitranBand = (id: string): HitranBand | undefined => HITRAN_BANDS.find((b) => b.id === id);

/** Wavelength is inside a named band's window. Useful for fall-through routing. */
export const bandContainingWavelength = (lambdaUm: number): HitranBand | undefined =>
	HITRAN_BANDS.find((b) => Math.abs(lambdaUm - b.centerUm) <= b.halfWidthUm);

/**
 * One HITRAN line — the minimal subset needed for Voigt profile evaluation.
 * All units are HITRAN's native conventions (cm⁻¹, atm, cm⁻¹/(molecule·cm⁻²)).
 */
export interface HitranLine {
	/** Wavenumber center ν₀ in cm⁻¹. */
	readonly nu0: number;
	/** Line intensity S at T_ref = 296 K, cm⁻¹/(molecule·cm⁻²). */
	readonly S: number;
	/** Air-broadened HWHM γ_air at T_ref, cm⁻¹/atm. */
	readonly gammaAir: number;
	/** Self-broadened HWHM γ_self at T_ref, cm⁻¹/atm. */
	readonly gammaSelf: number;
	/** Lower-state energy E″, cm⁻¹. */
	readonly Elower: number;
	/** Temperature dependence exponent n_air. */
	readonly nAir: number;
}

export interface CuratedBandLines {
	readonly bandId: string;
	readonly molecule: HitranMolecule;
	readonly source: string;
	readonly fetchedAt: string;
	readonly lines: ReadonlyArray<HitranLine>;
}

export interface CuratedHitranArchive {
	readonly version: number;
	readonly note: string;
	readonly attribution: string;
	readonly bands: ReadonlyArray<CuratedBandLines>;
}

/** Convert µm → cm⁻¹ (1 / (λ[cm])). */
export const umToCm1 = (lambdaUm: number): number => 1e4 / lambdaUm;
/** Convert cm⁻¹ → µm. */
export const cm1ToUm = (nu: number): number => 1e4 / nu;
