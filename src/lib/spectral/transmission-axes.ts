/**
 * Shared definitions for the spectral-transmission lookup table. The bake
 * script (`scripts/bake-spectral-lut.ts`) writes a JSON file with these
 * exact axes; the runtime `TransmissionEstimator` quadrilinear-interpolates
 * over the same grid.
 *
 * V0 axes are sized for fast first-load (~150 KB JSON). PR-G2 will widen
 * each axis once the SMARTS + SBDART bake is in place — the consumer
 * interface (TransmissionEstimator.estimate) stays the same; only the
 * static asset gets replaced.
 */

export const SPECTRAL_LUT_VERSION = 1 as const;
export const SPECTRAL_LUT_SOURCE = 'analytical-v0' as const;

/** Axis values, all in physical units. Must remain sorted ascending. */
export const PWV_MM_AXIS: ReadonlyArray<number> = [0, 10, 20, 30, 50];
export const AOD550_AXIS: ReadonlyArray<number> = [0, 0.1, 0.3, 0.7, 1.5];
export const ANGSTROM_AXIS: ReadonlyArray<number> = [1.0, 1.5];
export const O3_DU_AXIS: ReadonlyArray<number> = [275, 350, 425];
export const ZENITH_DEG_AXIS: ReadonlyArray<number> = [0, 30, 60, 75];

/** Wavelength grid, log-spaced µm, 60 samples spanning 0.3 → 30 µm. */
export const WAVELENGTH_UM_AXIS: ReadonlyArray<number> = (() => {
	const n = 60;
	const lo = Math.log(0.3);
	const hi = Math.log(30);
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		out.push(Math.exp(lo + ((hi - lo) * i) / (n - 1)));
	}
	return out;
})();

/** Axes input shape for `TransmissionEstimator.estimate`. */
export interface TransmissionInput {
	readonly pwvMm: number;
	readonly aod550: number;
	readonly angstrom: number;
	readonly o3Du: number;
	readonly zenithDeg: number;
}

export interface TransmissionLutAxes {
	readonly pwvMm: ReadonlyArray<number>;
	readonly aod550: ReadonlyArray<number>;
	readonly angstrom: ReadonlyArray<number>;
	readonly o3Du: ReadonlyArray<number>;
	readonly zenithDeg: ReadonlyArray<number>;
}

export interface SpectralLut {
	readonly version: number;
	readonly source: string;
	readonly generatedAt: string;
	readonly axes: TransmissionLutAxes;
	readonly wavelengthsUm: ReadonlyArray<number>;
	/**
	 * Flattened 5-D array, axis order
	 *   `pwvMm, aod550, angstrom, o3Du, zenithDeg, wavelengthUm`.
	 * Length = product of axis sizes × wavelength samples.
	 */
	readonly transmissionFlat: ReadonlyArray<number>;
}

/** Total flat-array length implied by the axes. */
export const lutSize = (axes: TransmissionLutAxes, wavelengthCount: number): number =>
	axes.pwvMm.length *
	axes.aod550.length *
	axes.angstrom.length *
	axes.o3Du.length *
	axes.zenithDeg.length *
	wavelengthCount;

/** Stable filename / URL for the baked LUT. Browser fetches this lazily. */
export const SPECTRAL_LUT_URL = '/spectral-lut.json';
