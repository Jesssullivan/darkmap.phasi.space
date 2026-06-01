import { describe, expect, it } from 'vitest';
import {
	atmosphericLossDb,
	geometricSpreadLossDb,
	hufnagelValleyCn2,
	linkMargin,
	pointingLossDb,
	rytovVariance,
	scintillationFadeDb,
	erfcInv,
	type LossTerm,
} from './linkBudget';

describe('atmosphericLossDb', () => {
	it('is 0 dB for a perfectly clear path (T=1)', () => {
		expect(atmosphericLossDb(1)).toBeCloseTo(0, 6);
	});
	it('is ~3 dB at T=0.5 and ~10 dB at T=0.1', () => {
		expect(atmosphericLossDb(0.5)).toBeCloseTo(3.01, 1);
		expect(atmosphericLossDb(0.1)).toBeCloseTo(10, 6);
	});
	it('caps an opaque path instead of returning Infinity', () => {
		const loss = atmosphericLossDb(0);
		expect(Number.isFinite(loss)).toBe(true);
		expect(loss).toBeGreaterThanOrEqual(60);
	});
	it('monotonically increases as transmittance falls', () => {
		expect(atmosphericLossDb(0.9)).toBeLessThan(atmosphericLossDb(0.4));
	});
});

describe('geometricSpreadLossDb', () => {
	it('is ~0 dB when the Rx aperture captures the whole spot', () => {
		// 0.1 mrad over 1 km ⇒ 0.1 m spot; a 0.5 m aperture overfills it.
		expect(geometricSpreadLossDb({ beamDivergenceMrad: 0.1, rangeKm: 1, rxApertureM: 0.5 })).toBeCloseTo(0, 6);
	});
	it('grows ~20·log10(range) in the far field (spot ∝ range)', () => {
		const at10 = geometricSpreadLossDb({ beamDivergenceMrad: 1, rangeKm: 10, rxApertureM: 0.1 });
		const at20 = geometricSpreadLossDb({ beamDivergenceMrad: 1, rangeKm: 20, rxApertureM: 0.1 });
		// Doubling range doubles the spot diameter ⇒ 4× area ⇒ +6.02 dB loss.
		expect(at20 - at10).toBeCloseTo(6.02, 1);
	});
	it('a tighter beam (less divergence) loses less', () => {
		const tight = geometricSpreadLossDb({ beamDivergenceMrad: 0.5, rangeKm: 10, rxApertureM: 0.1 });
		const wide = geometricSpreadLossDb({ beamDivergenceMrad: 2, rangeKm: 10, rxApertureM: 0.1 });
		expect(tight).toBeLessThan(wide);
	});
});

describe('pointingLossDb', () => {
	it('is 0 dB for a perfectly-aimed link', () => {
		expect(pointingLossDb({ pointingErrorMrad: 0, beamDivergenceMrad: 2 })).toBe(0);
	});
	it('grows with the mis-aim ratio', () => {
		const small = pointingLossDb({ pointingErrorMrad: 0.2, beamDivergenceMrad: 2 });
		const big = pointingLossDb({ pointingErrorMrad: 0.8, beamDivergenceMrad: 2 });
		expect(small).toBeGreaterThan(0);
		expect(big).toBeGreaterThan(small);
	});
});

describe('hufnagelValleyCn2', () => {
	it('returns the ground Cn² at the surface and decays with altitude', () => {
		const ground = hufnagelValleyCn2({ altitudeM: 0 });
		const aloft = hufnagelValleyCn2({ altitudeM: 2000 });
		expect(ground).toBeGreaterThan(aloft);
		expect(ground).toBeGreaterThan(1e-15);
		expect(ground).toBeLessThan(1e-13);
	});
});

describe('rytovVariance', () => {
	it('increases with Cn² and path length', () => {
		const base = rytovVariance({ cn2: 1e-15, wavelengthNm: 1550, pathLengthKm: 5 });
		expect(rytovVariance({ cn2: 1e-14, wavelengthNm: 1550, pathLengthKm: 5 })).toBeGreaterThan(base);
		expect(rytovVariance({ cn2: 1e-15, wavelengthNm: 1550, pathLengthKm: 10 })).toBeGreaterThan(base);
	});
	it('a calm short near-IR path is weak turbulence (σ_R² < 1)', () => {
		expect(rytovVariance({ cn2: 1e-15, wavelengthNm: 1550, pathLengthKm: 2 })).toBeLessThan(1);
	});
});

describe('scintillationFadeDb', () => {
	it('is 0 with no turbulence', () => {
		expect(scintillationFadeDb(0)).toBeCloseTo(0, 6);
	});
	it('demands more fade margin for higher availability', () => {
		const three9 = scintillationFadeDb(0.3, 0.999);
		const two9 = scintillationFadeDb(0.3, 0.99);
		expect(three9).toBeGreaterThan(two9);
		expect(two9).toBeGreaterThan(0);
	});
	it('stays finite + bounded under strong turbulence (saturation correction)', () => {
		const fade = scintillationFadeDb(25, 0.999);
		expect(Number.isFinite(fade)).toBe(true);
		expect(fade).toBeLessThan(20);
	});
});

describe('erfcInv', () => {
	it('erfcInv(1) ≈ 0 and erfcInv(0.01) ≈ 1.82', () => {
		expect(erfcInv(1)).toBeCloseTo(0, 2);
		expect(erfcInv(0.01)).toBeCloseTo(1.82, 1);
	});
});

describe('linkMargin', () => {
	const losses: LossTerm[] = [
		{ label: 'Geometric spread', db: 20 },
		{ label: 'Atmospheric (AOD/T)', db: 4 },
		{ label: 'Pointing', db: 1 },
		{ label: 'Scintillation', db: 2, estimate: true },
	];

	it('sums the ledger: Prx = Ptx + Gtx − Σloss, margin = Prx − RxSens', () => {
		const r = linkMargin({ txPowerDbm: 10, txGainDbi: 0, rxSensitivityDbm: -30, losses });
		expect(r.totalLossDb).toBe(27);
		expect(r.prxDbm).toBe(-17); // 10 − 27
		expect(r.marginDb).toBe(13); // −17 − (−30)
		expect(r.verdict).toBe('go');
	});

	it('flags no-go when received power is below the Rx threshold', () => {
		const r = linkMargin({ txPowerDbm: 0, rxSensitivityDbm: -20, losses });
		expect(r.prxDbm).toBe(-27);
		expect(r.marginDb).toBe(-7);
		expect(r.verdict).toBe('no-go');
	});

	it('flags marginal in the reserve band just above threshold', () => {
		// margin = +2 dB, below the default 3 dB marginal band.
		const r = linkMargin({ txPowerDbm: 0, rxSensitivityDbm: -29, losses });
		expect(r.marginDb).toBe(2);
		expect(r.verdict).toBe('marginal');
	});

	it('preserves the itemized breakdown for the term-by-term UI', () => {
		const r = linkMargin({ txPowerDbm: 10, rxSensitivityDbm: -30, losses });
		expect(r.breakdown).toHaveLength(4);
		expect(r.breakdown.find((t) => t.label === 'Scintillation')?.estimate).toBe(true);
	});
});
