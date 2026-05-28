import { describe, expect, it } from 'vitest';
import { analyticalTransmission } from './analytical';
import { smartsAnalogSpectrum, smartsAnalogTransmission } from './smarts-analog';

const CLEAN = { pwvMm: 0, aod550: 0, angstrom: 1.5, o3Du: 350, zenithDeg: 0 };

describe('smartsAnalogTransmission — clean-sky baseline', () => {
	it('is dominated by Rayleigh in the visible (clean dry atmosphere)', () => {
		const t550 = smartsAnalogTransmission(0.55, CLEAN);
		expect(t550).toBeGreaterThan(0.85);
		expect(t550).toBeLessThan(0.95);
	});

	it('approaches 1.0 in the SWIR window for a clean atmosphere', () => {
		const t = smartsAnalogTransmission(1.6, CLEAN);
		expect(t).toBeGreaterThan(0.95);
	});

	it('drops sharply in the UV (Hartley ozone band)', () => {
		const t = smartsAnalogTransmission(0.26, CLEAN);
		expect(t).toBeLessThan(0.5);
	});
});

describe('smartsAnalogTransmission — water vapor PM model', () => {
	it('high PWV crushes 1.38 µm transmission', () => {
		const wet = smartsAnalogTransmission(1.38, { ...CLEAN, pwvMm: 50 });
		const dry = smartsAnalogTransmission(1.38, { ...CLEAN, pwvMm: 0 });
		expect(dry - wet).toBeGreaterThan(0.5);
		expect(wet).toBeLessThan(0.3);
	});

	it('PWV scales as u^b — doubling PWV does NOT double tau in log space', () => {
		// PM band model: τ ∝ u^b with b≈0.78 < 1, so τ scales sub-linearly.
		const center = 1.38;
		const t1 = smartsAnalogTransmission(center, { ...CLEAN, pwvMm: 10 });
		const t2 = smartsAnalogTransmission(center, { ...CLEAN, pwvMm: 20 });
		const tau1 = -Math.log(Math.max(t1, 1e-10));
		const tau2 = -Math.log(Math.max(t2, 1e-10));
		const ratio = tau2 / tau1;
		// Linear scaling would give ratio = 2; PM b≈0.78 → ratio ≈ 2^0.78 ≈ 1.72.
		expect(ratio).toBeLessThan(1.9);
		expect(ratio).toBeGreaterThan(1.5);
	});
});

describe('smartsAnalogTransmission — comparison with V0 analytical', () => {
	it('matches V0 to ±10% at 0.55 µm clean-sky baseline', () => {
		const tSmarts = smartsAnalogTransmission(0.55, CLEAN);
		const tV0 = analyticalTransmission(0.55, CLEAN);
		expect(Math.abs(tSmarts - tV0)).toBeLessThan(0.1);
	});

	it('returns values in [0, 1] over a broad input sweep', () => {
		const inputs = [
			{ pwvMm: 0, aod550: 0, angstrom: 1.5, o3Du: 200, zenithDeg: 0 },
			{ pwvMm: 60, aod550: 2, angstrom: 0.5, o3Du: 500, zenithDeg: 80 },
			{ pwvMm: 20, aod550: 0.5, angstrom: 1.4, o3Du: 350, zenithDeg: 45 },
		];
		for (const input of inputs) {
			for (const lambda of [0.3, 0.55, 1.0, 1.38, 2.0, 5.0, 10.0, 30.0]) {
				const t = smartsAnalogTransmission(lambda, input);
				expect(t).toBeGreaterThanOrEqual(0);
				expect(t).toBeLessThanOrEqual(1);
			}
		}
	});
});

describe('smartsAnalogSpectrum', () => {
	it('returns a vector matching the input grid', () => {
		const wl = [0.4, 0.55, 0.8, 1.6];
		const out = smartsAnalogSpectrum(wl, CLEAN);
		expect(out).toHaveLength(wl.length);
	});
});
