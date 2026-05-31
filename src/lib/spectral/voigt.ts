/**
 * Voigt line-profile evaluator for V3b line-by-line transmission.
 *
 * Uses the Thompson (1987) pseudo-Voigt approximation:
 *   V(x) ≈ η · L(x; α_V) + (1−η) · G(x; α_V)
 * where α_V is the Voigt HWHM combined via Olivero & Longbothum (1977):
 *   FWHM_V = 0.5346·FWHM_L + √(0.2166·FWHM_L² + FWHM_D²)
 * and the mixing weight η is the standard Thompson cubic in (FWHM_L / FWHM_V).
 *
 * Accuracy: ~1 % vs the true Voigt convolution across the regime relevant
 * to atmospheric LBL (Doppler-dominated UV/visible → Lorentzian-dominated
 * troposphere). Cheap enough to evaluate per-line per-wavelength inside
 * the bake script without WASM heroics.
 *
 * References:
 *   Olivero & Longbothum (1977) JQSRT 17, 233.
 *   Thompson, Cox & Hastings (1987) J. Appl. Cryst. 20, 79.
 *   Humlíček (1979) JQSRT 21, 309 — rational approximation; not used here
 *     but ships in V3b's roadmap as a possible refinement.
 */

const LN2 = Math.LN2;
const SQRT_LN2_OVER_PI = Math.sqrt(LN2 / Math.PI);

/**
 * Evaluate the Voigt profile at `deltaNu = ν − ν₀` (cm⁻¹) given Doppler
 * HWHM `alphaD` (cm⁻¹) and Lorentz HWHM `alphaL` (cm⁻¹).
 *
 * Returns the profile value normalized so ∫ V(δν) dδν = 1 (cm).
 */
export const voigtProfile = (deltaNu: number, alphaD: number, alphaL: number): number => {
	if (alphaD < 0 || alphaL < 0) {
		throw new Error(`voigtProfile: HWHMs must be non-negative (got αD=${alphaD}, αL=${alphaL})`);
	}
	const fwhmL = 2 * alphaL;
	const fwhmD = 2 * alphaD;
	if (fwhmL === 0 && fwhmD === 0) return deltaNu === 0 ? Infinity : 0;
	const fwhmV = 0.5346 * fwhmL + Math.sqrt(0.2166 * fwhmL * fwhmL + fwhmD * fwhmD);
	const alphaV = fwhmV / 2;
	const ratio = fwhmV === 0 ? 0 : fwhmL / fwhmV;
	const eta = 1.36603 * ratio - 0.47719 * ratio * ratio + 0.11116 * ratio * ratio * ratio;

	const x = deltaNu / alphaV;
	const gauss = (SQRT_LN2_OVER_PI / alphaV) * Math.exp(-LN2 * x * x);
	const lorentz = alphaV / Math.PI / (deltaNu * deltaNu + alphaV * alphaV);
	return eta * lorentz + (1 - eta) * gauss;
};

// SI constants for the Doppler-broadening calculation. We sidestep the unit
// jungle (k_B in cgs vs SI vs HITRAN) by computing the thermal-speed term in
// SI and dividing by the speed of light at the end.
const K_B_SI = 1.380649e-23; // J/K
const N_A = 6.02214076e23; // mol⁻¹
const C_M_S = 2.99792458e8; // m/s

/**
 * Doppler HWHM at temperature `T` (K) for a line centered at `nu0` (cm⁻¹)
 * and molecule molar mass `molarMassGperMol` (g/mol).
 *
 * α_D = (ν₀/c) · √(2·k_B·T·ln 2 / m_molecule)
 */
export const dopplerHwhm = (nu0: number, temperatureK: number, molarMassGperMol: number): number => {
	if (nu0 <= 0 || temperatureK <= 0 || molarMassGperMol <= 0) return 0;
	const massKg = molarMassGperMol / 1000 / N_A;
	const thermalSpeed = Math.sqrt((2 * K_B_SI * temperatureK * LN2) / massKg);
	return (nu0 * thermalSpeed) / C_M_S;
};

/**
 * Pressure-broadened Lorentz HWHM, scaled from HITRAN reference (296 K, 1 atm)
 * via the temperature-dependence exponent `nAir`.
 */
export const pressureHwhm = (gammaAirAtRef: number, pressureAtm: number, temperatureK: number, nAir: number): number =>
	gammaAirAtRef * pressureAtm * Math.pow(296 / temperatureK, nAir);
