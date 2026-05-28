/**
 * V0 analytical atmospheric transmission. Closed-form physics good enough
 * for a clear-sky engineering estimate; the bake script feeds the same
 * functions to produce the shipped LUT, and the test suite cross-checks
 * the LUT interp against a few canonical (input, expected T) tuples.
 *
 * This is NOT a substitute for SMARTS / SBDART / MODTRAN. The model
 * captures the four dominant contributors:
 *
 *   - **Rayleigh scattering** — λ⁻⁴ baseline (Bodhaine et al. 1999).
 *   - **Aerosol extinction** — Ångström τ(λ) = AOD550 × (λ/0.55)^(-α).
 *   - **Water vapor** — empirical bands at 0.94 / 1.13 / 1.38 / 1.87 / 2.7 /
 *     6.3 µm with PWV-scaled depth; continuum near zero between bands.
 *   - **Ozone** — Chappuis (450–650 nm) weak + Hartley (200–300 nm) strong;
 *     scales linearly with O₃ column.
 *
 * Airmass uses Kasten-Young (1989) so zenith ≤ 89° stays bounded.
 *
 * Output: monochromatic T(λ) at a single (pwv, aod, α, o3, z) tuple, valid
 * over ~0.3–30 µm. Outside that range we just compute the same formulae —
 * the regions just aren't relevant for what PR-H surfaces.
 */

import type { TransmissionInput } from './transmission-axes';

/**
 * Kasten-Young 1989 airmass. Returns sec(z) for small zenith and tapers
 * smoothly at the horizon instead of blowing up.
 */
export const airmass = (zenithDeg: number): number => {
	const z = Math.max(0, Math.min(89.5, zenithDeg));
	const cosZ = Math.cos((z * Math.PI) / 180);
	return 1 / (cosZ + 0.50572 * Math.pow(96.07995 - z, -1.6364));
};

const RAYLEIGH_COEFF = 0.00879; // Bodhaine 1999 mid-latitude best fit
const RAYLEIGH_EXP = 4.09;

/** Sea-level Rayleigh optical depth at λ in µm. */
const tauRayleigh = (lambdaUm: number): number => RAYLEIGH_COEFF * Math.pow(lambdaUm, -RAYLEIGH_EXP);

/** Aerosol optical depth at λ from AOD550 and Ångström exponent. */
const tauAerosol = (lambdaUm: number, aod550: number, angstrom: number): number => {
	if (aod550 <= 0) return 0;
	return aod550 * Math.pow(lambdaUm / 0.55, -angstrom);
};

interface H2OBand {
	readonly center: number;
	readonly fwhm: number;
	/** Peak optical depth at PWV = 15 mm (a reasonable mid-latitude column). */
	readonly peakAtRef: number;
}

const H2O_BANDS: ReadonlyArray<H2OBand> = [
	{ center: 0.94, fwhm: 0.04, peakAtRef: 0.6 },
	{ center: 1.13, fwhm: 0.04, peakAtRef: 0.8 },
	{ center: 1.38, fwhm: 0.06, peakAtRef: 1.8 },
	{ center: 1.87, fwhm: 0.08, peakAtRef: 2.2 },
	{ center: 2.7, fwhm: 0.15, peakAtRef: 2.8 },
	{ center: 3.2, fwhm: 0.2, peakAtRef: 1.5 },
	{ center: 6.3, fwhm: 0.6, peakAtRef: 4.0 },
];
const H2O_REF_PWV_MM = 15;

const tauWater = (lambdaUm: number, pwvMm: number): number => {
	if (pwvMm <= 0) return 0;
	const scale = pwvMm / H2O_REF_PWV_MM;
	let tau = 0;
	for (const band of H2O_BANDS) {
		const sigma = band.fwhm / 2.355;
		const dx = (lambdaUm - band.center) / sigma;
		tau += band.peakAtRef * Math.exp(-0.5 * dx * dx) * scale;
	}
	return tau;
};

const O3_REF_DU = 350; // climatological mid-latitude

const tauOzone = (lambdaUm: number, o3Du: number): number => {
	const scale = o3Du / O3_REF_DU;
	let tau = 0;
	// Hartley (200–300 nm), peak τ ≈ 4 at reference column.
	if (lambdaUm < 0.31) {
		const x = (lambdaUm - 0.255) / 0.045;
		tau += 4 * Math.exp(-2 * x * x);
	}
	// Huggins (300–360 nm), shoulder.
	if (lambdaUm < 0.36) {
		const x = (lambdaUm - 0.32) / 0.03;
		tau += 0.6 * Math.exp(-0.5 * x * x);
	}
	// Chappuis (450–650 nm), broad weak band, peak τ ≈ 0.05.
	if (lambdaUm > 0.45 && lambdaUm < 0.7) {
		const x = (lambdaUm - 0.6) / 0.06;
		tau += 0.05 * Math.exp(-0.5 * x * x);
	}
	return tau * scale;
};

/** Total monochromatic transmission at a single wavelength. */
export const analyticalTransmission = (lambdaUm: number, input: TransmissionInput): number => {
	const m = airmass(input.zenithDeg);
	const tauTotal =
		tauRayleigh(lambdaUm) +
		tauAerosol(lambdaUm, input.aod550, input.angstrom) +
		tauWater(lambdaUm, input.pwvMm) +
		tauOzone(lambdaUm, input.o3Du);
	const T = Math.exp(-m * tauTotal);
	// Numerical clamp — interpolation downstream expects [0, 1] strictly.
	return T < 0 ? 0 : T > 1 ? 1 : T;
};

/** Spectrum convenience: T(λ) over a wavelength grid for one input. */
export const analyticalSpectrum = (wavelengthsUm: ReadonlyArray<number>, input: TransmissionInput): number[] =>
	wavelengthsUm.map((lambda) => analyticalTransmission(lambda, input));
