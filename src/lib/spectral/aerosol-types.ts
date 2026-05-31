/**
 * Aerosol catalog for V2 live Mie recompute. Each entry pairs a published
 * complex refractive index n+ik sampled at ~10 wavelengths spanning 0.3-30 µm
 * with a log-normal size distribution (median radius + geometric σ).
 *
 * The MieScatteringService (V2-C) consumes these tables: at each wavelength,
 * `refractiveIndexAt(type, lambda)` interpolates n+ik linearly in lambda; the
 * size distribution is integrated over via Gauss-Hermite or trapezoidal
 * quadrature against the per-radius `mie(x, m)` output.
 *
 * References (one per type):
 *
 *   - **smoke** — Reid et al. 2005, ACP, "A review of biomass burning
 *     emissions": fresh wildfire smoke n ≈ 1.55, k ≈ 0.04, r_g ≈ 0.14 µm,
 *     σ_g ≈ 1.6.
 *   - **dust** — d'Almeida et al. 1991 OPAC; Saharan-type, n ≈ 1.53 ± 0.02
 *     across visible, k declines from 0.008 (UV) to 0.001 (SWIR).
 *     r_g ≈ 0.5 µm, σ_g ≈ 2.0 (lognormal-skewed coarse mode).
 *   - **urban** — Hess et al. 1998 OPAC continental-polluted: n ≈ 1.5,
 *     k ≈ 0.015 in visible. r_g ≈ 0.05 µm, σ_g ≈ 2.24 (accumulation mode).
 *   - **pollen** — Griffiths 2012 / Hoyningen-Huene; large bioaerosols
 *     n ≈ 1.53, k ≈ 0.005 across visible. r_g ≈ 25 µm, σ_g ≈ 1.3.
 *   - **mixed** — d'Almeida continental-average between dust and urban for a
 *     generic non-specific aerosol baseline.
 *
 * All values are engineering estimates — published refractive-index data is
 * a single canonical fit per source. The live Mie computation that consumes
 * these is itself an engineering estimate, so the catalog matches the rest
 * of the spectral plane in fidelity.
 */

import type { Complex } from './mie';

export type AerosolType = 'smoke' | 'dust' | 'urban' | 'pollen' | 'mixed';

/**
 * Complex refractive index sampled at a specific wavelength.
 * `re` = real part n; `im` = imaginary part k (positive for absorbing media).
 */
export interface RefractiveIndexSample {
	readonly lambdaUm: number;
	readonly n: number;
	readonly k: number;
}

/** Log-normal size distribution parameters. */
export interface SizeDistribution {
	/** Geometric median (mode) radius in µm. */
	readonly modeRadiusUm: number;
	/** Geometric standard deviation (dimensionless). */
	readonly geometricStdDev: number;
}

export interface AerosolEntry {
	readonly id: AerosolType;
	readonly label: string;
	readonly description: string;
	readonly refractiveIndex: ReadonlyArray<RefractiveIndexSample>;
	readonly sizeDistribution: SizeDistribution;
	readonly citation: string;
}

const AEROSOLS: Readonly<Record<AerosolType, AerosolEntry>> = {
	smoke: {
		id: 'smoke',
		label: 'Smoke (wildfire)',
		description: 'Fresh biomass-burning aerosol — strong absorber, fine mode, Ångström ≈ 1.8-2.2.',
		citation: 'Reid et al. 2005, ACP 5 (2005) 799-825',
		refractiveIndex: [
			{ lambdaUm: 0.3, n: 1.55, k: 0.055 },
			{ lambdaUm: 0.4, n: 1.55, k: 0.045 },
			{ lambdaUm: 0.55, n: 1.55, k: 0.04 },
			{ lambdaUm: 0.7, n: 1.54, k: 0.035 },
			{ lambdaUm: 1.0, n: 1.53, k: 0.03 },
			{ lambdaUm: 1.6, n: 1.52, k: 0.025 },
			{ lambdaUm: 2.5, n: 1.5, k: 0.02 },
			{ lambdaUm: 5.0, n: 1.45, k: 0.05 },
			{ lambdaUm: 10.0, n: 1.45, k: 0.07 },
			{ lambdaUm: 20.0, n: 1.42, k: 0.1 },
		],
		sizeDistribution: { modeRadiusUm: 0.14, geometricStdDev: 1.6 },
	},
	dust: {
		id: 'dust',
		label: 'Dust (Saharan)',
		description: 'Coarse-mode mineral dust — weak absorber in visible, strong in UV. Ångström ≈ 0.3-0.5.',
		citation: 'd’Almeida, Koepke & Shettle 1991 / OPAC',
		refractiveIndex: [
			{ lambdaUm: 0.3, n: 1.53, k: 0.008 },
			{ lambdaUm: 0.4, n: 1.53, k: 0.005 },
			{ lambdaUm: 0.55, n: 1.53, k: 0.003 },
			{ lambdaUm: 0.7, n: 1.53, k: 0.002 },
			{ lambdaUm: 1.0, n: 1.52, k: 0.0015 },
			{ lambdaUm: 1.6, n: 1.52, k: 0.001 },
			{ lambdaUm: 2.5, n: 1.51, k: 0.0008 },
			{ lambdaUm: 5.0, n: 1.45, k: 0.005 },
			{ lambdaUm: 10.0, n: 1.7, k: 0.4 },
			{ lambdaUm: 20.0, n: 1.4, k: 0.08 },
		],
		sizeDistribution: { modeRadiusUm: 0.5, geometricStdDev: 2.0 },
	},
	urban: {
		id: 'urban',
		label: 'Urban',
		description: 'Continental-polluted accumulation-mode aerosol. Ångström ≈ 1.2-1.5.',
		citation: 'Hess, Koepke & Schult 1998, BAMS 79 (OPAC)',
		refractiveIndex: [
			{ lambdaUm: 0.3, n: 1.5, k: 0.025 },
			{ lambdaUm: 0.4, n: 1.5, k: 0.02 },
			{ lambdaUm: 0.55, n: 1.5, k: 0.015 },
			{ lambdaUm: 0.7, n: 1.49, k: 0.014 },
			{ lambdaUm: 1.0, n: 1.48, k: 0.013 },
			{ lambdaUm: 1.6, n: 1.47, k: 0.012 },
			{ lambdaUm: 2.5, n: 1.45, k: 0.011 },
			{ lambdaUm: 5.0, n: 1.4, k: 0.05 },
			{ lambdaUm: 10.0, n: 1.35, k: 0.08 },
			{ lambdaUm: 20.0, n: 1.3, k: 0.12 },
		],
		sizeDistribution: { modeRadiusUm: 0.05, geometricStdDev: 2.24 },
	},
	pollen: {
		id: 'pollen',
		label: 'Pollen (bioaerosol)',
		description: 'Bioaerosol grains — large size, mild absorption. Daytime / low-elevation only.',
		citation: 'Griffiths 2012; Hoyningen-Huene et al.',
		refractiveIndex: [
			{ lambdaUm: 0.3, n: 1.53, k: 0.01 },
			{ lambdaUm: 0.4, n: 1.53, k: 0.008 },
			{ lambdaUm: 0.55, n: 1.53, k: 0.005 },
			{ lambdaUm: 0.7, n: 1.52, k: 0.005 },
			{ lambdaUm: 1.0, n: 1.52, k: 0.004 },
			{ lambdaUm: 1.6, n: 1.51, k: 0.004 },
			{ lambdaUm: 2.5, n: 1.5, k: 0.005 },
			{ lambdaUm: 5.0, n: 1.45, k: 0.02 },
			{ lambdaUm: 10.0, n: 1.4, k: 0.05 },
			{ lambdaUm: 20.0, n: 1.35, k: 0.08 },
		],
		sizeDistribution: { modeRadiusUm: 25, geometricStdDev: 1.3 },
	},
	mixed: {
		id: 'mixed',
		label: 'Mixed continental',
		description: 'Generic continental-average between dust and urban; useful as a non-specific baseline.',
		citation: 'd’Almeida et al. 1991 continental-average',
		refractiveIndex: [
			{ lambdaUm: 0.3, n: 1.52, k: 0.015 },
			{ lambdaUm: 0.4, n: 1.52, k: 0.012 },
			{ lambdaUm: 0.55, n: 1.52, k: 0.009 },
			{ lambdaUm: 0.7, n: 1.51, k: 0.008 },
			{ lambdaUm: 1.0, n: 1.5, k: 0.007 },
			{ lambdaUm: 1.6, n: 1.5, k: 0.006 },
			{ lambdaUm: 2.5, n: 1.48, k: 0.006 },
			{ lambdaUm: 5.0, n: 1.43, k: 0.03 },
			{ lambdaUm: 10.0, n: 1.5, k: 0.15 },
			{ lambdaUm: 20.0, n: 1.35, k: 0.1 },
		],
		sizeDistribution: { modeRadiusUm: 0.2, geometricStdDev: 2.0 },
	},
};

export const AEROSOL_TYPES: ReadonlyArray<AerosolType> = ['smoke', 'dust', 'urban', 'pollen', 'mixed'];

export const aerosolEntry = (type: AerosolType): AerosolEntry => AEROSOLS[type];

/**
 * Linear-in-λ interpolation of refractive index between catalog samples.
 * Outside the sampled range, clamps to the nearest endpoint.
 */
export const refractiveIndexAt = (type: AerosolType, lambdaUm: number): Complex => {
	const samples = AEROSOLS[type].refractiveIndex;
	if (samples.length === 0) throw new Error(`aerosol ${type} has no refractive-index samples`);
	if (lambdaUm <= samples[0].lambdaUm) {
		return { re: samples[0].n, im: samples[0].k };
	}
	const last = samples[samples.length - 1];
	if (lambdaUm >= last.lambdaUm) {
		return { re: last.n, im: last.k };
	}
	for (let i = 1; i < samples.length; i++) {
		if (lambdaUm <= samples[i].lambdaUm) {
			const a = samples[i - 1];
			const b = samples[i];
			const t = (lambdaUm - a.lambdaUm) / (b.lambdaUm - a.lambdaUm);
			return { re: a.n + t * (b.n - a.n), im: a.k + t * (b.k - a.k) };
		}
	}
	return { re: last.n, im: last.k };
};

/**
 * Sample radii from the log-normal distribution at evenly-spaced ln(r) points
 * within ±3σ of the mode. Returns `{ radiusUm, weight }` pairs where weights
 * sum to 1 — suitable for trapezoidal integration of Q_ext(r,λ) against
 * the size distribution.
 */
export interface RadiusBin {
	readonly radiusUm: number;
	readonly weight: number;
}

export const sampleSizeDistribution = (dist: SizeDistribution, bins = 12): ReadonlyArray<RadiusBin> => {
	const lnRg = Math.log(dist.modeRadiusUm);
	const lnSig = Math.log(dist.geometricStdDev);
	const lnMin = lnRg - 3 * lnSig;
	const lnMax = lnRg + 3 * lnSig;
	const step = (lnMax - lnMin) / (bins - 1);
	const raw: RadiusBin[] = [];
	let sum = 0;
	for (let i = 0; i < bins; i++) {
		const lnR = lnMin + i * step;
		// Log-normal n(ln r) ∝ exp(-(ln r - ln r_g)² / (2 ln² σ_g))
		const z = (lnR - lnRg) / lnSig;
		const w = Math.exp(-0.5 * z * z);
		const r = Math.exp(lnR);
		raw.push({ radiusUm: r, weight: w });
		sum += w;
	}
	return raw.map(({ radiusUm, weight }) => ({ radiusUm, weight: weight / sum }));
};
