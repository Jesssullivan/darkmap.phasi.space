/**
 * FSO / laser link-budget math (S2 — Links lens).
 *
 * Turns the directable-boresight geometry + the measured-along-the-beam
 * atmospheric state (our T(λ) + path-AOD + airmass) into a dB/dBm loss ledger
 * and a link MARGIN + go/no-go — the differentiator generic calculators lack
 * (docs/ux/personas-and-lenses.md §4.3, §7C: "measured atmospheric state along
 * the real beam → margin").
 *
 * Honesty (the V6 bar): the geometric + atmospheric terms derive from real
 * geometry + modeled atmosphere; the turbulence/scintillation allowance is a
 * LABELED ESTIMATE (Hufnagel–Valley Cn² → Rytov variance → log-normal fade)
 * unless a measured Cn² is supplied. Every term is itemized — techs debug a
 * link budget term-by-term, not from a single number.
 *
 * Conventions: powers in dBm, gains in dBi, every loss a POSITIVE number of dB,
 * wavelength in nm, ranges in km, apertures in m, divergence/pointing in mrad.
 * Pure module (no DOM/runes/Effect) — unit-tested + enrolled in root_lib_test.
 */

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ───────────────────────────── atmospheric ──────────────────────────────

/**
 * Atmospheric extinction loss (dB) from the slant-path transmittance at the
 * operating wavelength. `transmittance` is T(λ) ∈ (0,1] along the boresight —
 * our TransmissionEstimator curve already bakes in the airmass, so pass the
 * value sampled at the laser wavelength. Loss = −10·log₁₀(T).
 */
export function atmosphericLossDb(transmittance: number): number {
	// Floor avoids −∞ for an opaque path; 1e-6 ⇒ 60 dB cap, already "no-go".
	const t = clamp(transmittance, 1e-6, 1);
	return -10 * Math.log10(t);
}

// ───────────────────────────── geometric ────────────────────────────────

export interface GeometricLossInput {
	/** Full-angle 1/e² beam divergence, mrad. */
	readonly beamDivergenceMrad: number;
	/** Slant range to the receiver, km. */
	readonly rangeKm: number;
	/** Receiver collecting-aperture diameter, m. */
	readonly rxApertureM: number;
	/** Transmit-aperture diameter, m (near-field offset; default 0 = point source). */
	readonly txApertureM?: number;
}

/**
 * FSO geometric (beam-spread) loss (dB): the transmitted beam widens to a spot
 * of diameter ≈ Dtx + θ·L at range; the receiver captures the fraction its
 * aperture subtends of that spot (power ∝ area). This is the optical analogue
 * of RF free-space path loss + antenna gains, and is normally the dominant term.
 *
 * spotDiameter_m = Dtx + (θ_mrad·1e-3)·(L_km·1e3) = Dtx + θ_mrad·L_km
 * capture = min(1, (Drx / spot)²);  loss_dB = −10·log₁₀(capture)
 */
export function geometricSpreadLossDb(input: GeometricLossInput): number {
	const { beamDivergenceMrad, rangeKm, rxApertureM, txApertureM = 0 } = input;
	// mrad · km = m (the 1e-3 and 1e3 cancel), so the far-field spread is just θ·L.
	const spotDiameterM = Math.max(txApertureM, txApertureM + beamDivergenceMrad * rangeKm);
	if (spotDiameterM <= 0) return 0;
	const capture = clamp((rxApertureM / spotDiameterM) ** 2, 1e-9, 1);
	return -10 * Math.log10(capture);
}

// ───────────────────────────── pointing ─────────────────────────────────

export interface PointingLossInput {
	/** RMS pointing/boresight error, mrad. */
	readonly pointingErrorMrad: number;
	/** Full-angle beam divergence, mrad (same definition as geometric). */
	readonly beamDivergenceMrad: number;
}

/**
 * Pointing (mis-aim) loss (dB) for a Gaussian beam. A boresight error θₚ moves
 * the receiver off the beam peak; the on-axis intensity falls as a Gaussian in
 * θₚ/θ₀ where θ₀ is the 1/e² half-divergence. loss_dB = 8.686·(θₚ/θ₀)²·2
 * → using I/I₀ = exp(−2(θₚ/θ₀)²): loss_dB = −10·log₁₀(exp(−2(θₚ/θ₀)²)).
 * Returns 0 for a perfectly-aimed (or unspecified) link.
 */
export function pointingLossDb(input: PointingLossInput): number {
	const { pointingErrorMrad, beamDivergenceMrad } = input;
	const halfDiv = beamDivergenceMrad / 2;
	if (halfDiv <= 0 || pointingErrorMrad <= 0) return 0;
	const ratio = pointingErrorMrad / halfDiv;
	return -10 * Math.log10(Math.exp(-2 * ratio * ratio));
}

// ──────────────────────── turbulence / scintillation ─────────────────────

/**
 * Hufnagel–Valley refractive-index structure parameter Cn²(h) (m^−2/3) — the
 * standard HV 5/7 profile (5 km coherence length, 7 km isoplanatic at λ=0.5µm)
 * unless overridden. `groundCn2` sets the surface value (default 1.7e-14, the
 * HV 5/7 ground value); `windRmsMs` the high-altitude wind RMS (default 21).
 * A ground-station laser path is near-surface, so the surface value dominates.
 */
export interface HvCn2Input {
	readonly altitudeM: number;
	readonly windRmsMs?: number;
	readonly groundCn2?: number;
}
export function hufnagelValleyCn2(input: HvCn2Input): number {
	const { altitudeM, windRmsMs = 21, groundCn2 = 1.7e-14 } = input;
	const h = Math.max(0, altitudeM);
	return (
		0.00594 * (windRmsMs / 27) ** 2 * (h * 1e-5) ** 10 * Math.exp(-h / 1000) +
		2.7e-16 * Math.exp(-h / 1500) +
		groundCn2 * Math.exp(-h / 100)
	);
}

export interface RytovInput {
	/** Refractive-index structure parameter Cn², m^−2/3. */
	readonly cn2: number;
	/** Operating wavelength, nm. */
	readonly wavelengthNm: number;
	/** Propagation path length, km. */
	readonly pathLengthKm: number;
}

/**
 * Plane-wave Rytov variance σ_R² = 1.23·Cn²·k^(7/6)·L^(11/6) (Andrews & Phillips,
 * *Laser Beam Propagation through Random Media*). The weak-fluctuation scintillation
 * index; σ_R² ≳ 1 indicates the onset of strong turbulence (saturation).
 */
export function rytovVariance(input: RytovInput): number {
	const { cn2, wavelengthNm, pathLengthKm } = input;
	const k = (2 * Math.PI) / (wavelengthNm * 1e-9); // wavenumber, 1/m
	const L = pathLengthKm * 1000; // m
	return 1.23 * cn2 * k ** (7 / 6) * L ** (11 / 6);
}

/**
 * Scintillation fade margin (dB) to hold a target availability, from the
 * (weak-turbulence) Rytov variance under a log-normal irradiance model. With
 * a saturation correction so strong turbulence doesn't over-predict:
 *   σ_I² = σ_R² / (1 + 1.11·σ_R^(12/5))^(5/6)   (Andrews aperture-averaging-free)
 * The fade depth at outage probability p_out (= 1 − availability) for log-normal
 * irradiance:  F_dB ≈ 4.343·(2·√(σ_I²)·erfc⁻¹(2·p_out) − 0.5·σ_I²)  — a LABELED
 * ESTIMATE (HV-class Cn²), not a measurement.
 */
export function scintillationFadeDb(rytovVar: number, availability = 0.99): number {
	const sigmaR2 = Math.max(0, rytovVar);
	// Saturation-corrected scintillation index (Andrews/Phillips).
	const sigmaI2 = sigmaR2 / (1 + 1.11 * sigmaR2 ** (6 / 5)) ** (5 / 6);
	const sigmaI = Math.sqrt(sigmaI2);
	const pOut = clamp(1 - availability, 1e-6, 0.5);
	// Log-normal fade depth at p_out (erfcInv via inverse-erf relation).
	const fade = 2 * sigmaI * erfcInv(2 * pOut) - 0.5 * sigmaI2;
	return Math.max(0, 4.343 * fade);
}

// ───────────────────────────── margin ───────────────────────────────────

/** A single itemized loss term in the ledger. */
export interface LossTerm {
	readonly label: string;
	readonly db: number;
	/** True when the term is a labeled estimate (e.g. turbulence), not measured/derived. */
	readonly estimate?: boolean;
}

export type LinkVerdict = 'go' | 'marginal' | 'no-go';

export interface LinkMarginInput {
	/** Transmit power, dBm. */
	readonly txPowerDbm: number;
	/** Transmit aperture/system gain, dBi (0 if the geometric term already accounts for it). */
	readonly txGainDbi?: number;
	/** Receiver sensitivity / threshold, dBm (the minimum detectable power). */
	readonly rxSensitivityDbm: number;
	/** Itemized losses (each a positive dB). */
	readonly losses: readonly LossTerm[];
	/**
	 * Margin (dB) above the Rx threshold required to call it a clean GO (a fade
	 * reserve sized to the target availability). Below 0 dB margin ⇒ no-go; in
	 * [0, marginalBelow) ⇒ marginal.
	 */
	readonly marginalBelowDb?: number;
}

export interface LinkMarginResult {
	/** Received power, dBm. */
	readonly prxDbm: number;
	/** Link margin = Prx − Rx sensitivity, dB. */
	readonly marginDb: number;
	/** Total of all loss terms, dB. */
	readonly totalLossDb: number;
	readonly verdict: LinkVerdict;
	/** The itemized ledger as passed (for the term-by-term breakdown UI). */
	readonly breakdown: readonly LossTerm[];
}

/**
 * Aggregate the ledger: Prx = Ptx + Gtx − Σlosses; margin = Prx − RxSensitivity.
 * Verdict: margin < 0 ⇒ no-go; 0 ≤ margin < marginalBelow ⇒ marginal; else go.
 */
export function linkMargin(input: LinkMarginInput): LinkMarginResult {
	const { txPowerDbm, txGainDbi = 0, rxSensitivityDbm, losses, marginalBelowDb = 3 } = input;
	const totalLossDb = losses.reduce((sum, l) => sum + l.db, 0);
	const prxDbm = txPowerDbm + txGainDbi - totalLossDb;
	const marginDb = prxDbm - rxSensitivityDbm;
	const verdict: LinkVerdict = marginDb < 0 ? 'no-go' : marginDb < marginalBelowDb ? 'marginal' : 'go';
	return { prxDbm, marginDb, totalLossDb, verdict, breakdown: losses };
}

// ───────────────────────────── helpers ──────────────────────────────────

/**
 * Inverse complementary error function, erfc⁻¹(x) for x ∈ (0,2), via a rational
 * approximation of erf⁻¹ (Giles 2010). Adequate for fade-margin estimation.
 */
export function erfcInv(x: number): number {
	return erfInv(1 - x);
}

function erfInv(x: number): number {
	const a = clamp(x, -0.999999, 0.999999);
	const ln = Math.log(1 - a * a);
	const t1 = 2 / (Math.PI * 0.147) + ln / 2;
	const t2 = ln / 0.147;
	const sign = a < 0 ? -1 : 1;
	return sign * Math.sqrt(Math.sqrt(t1 * t1 - t2) - t1);
}
