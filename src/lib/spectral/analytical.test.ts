import { describe, expect, it } from 'vitest';
import { airmass, analyticalSpectrum, analyticalTransmission } from './analytical';

const CLEAN = { pwvMm: 0, aod550: 0, angstrom: 1.5, o3Du: 350, zenithDeg: 0 };

describe('airmass — Kasten-Young', () => {
	it('returns 1.0 at zenith', () => {
		expect(airmass(0)).toBeCloseTo(1, 3);
	});
	it('grows monotonically with zenith', () => {
		expect(airmass(30)).toBeGreaterThan(airmass(0));
		expect(airmass(60)).toBeGreaterThan(airmass(30));
		expect(airmass(80)).toBeGreaterThan(airmass(60));
	});
	it('stays bounded near the horizon', () => {
		expect(Number.isFinite(airmass(89.5))).toBe(true);
		expect(airmass(89.5)).toBeLessThan(100);
	});
});

describe('analyticalTransmission — clean-sky baseline', () => {
	it('is dominated by Rayleigh in the visible (clean dry atmosphere)', () => {
		const T550 = analyticalTransmission(0.55, CLEAN);
		// Pure Rayleigh at 0.55 µm and zenith=0 gives T ≈ 0.9 (Bodhaine).
		expect(T550).toBeGreaterThan(0.85);
		expect(T550).toBeLessThan(0.95);
	});

	it('approaches 1.0 in the SWIR for a clean atmosphere', () => {
		const T2 = analyticalTransmission(2.0, CLEAN);
		expect(T2).toBeGreaterThan(0.95);
	});

	it('drops sharply in the UV (Rayleigh + ozone)', () => {
		const T350 = analyticalTransmission(0.35, CLEAN);
		expect(T350).toBeLessThan(0.8);
		const T260 = analyticalTransmission(0.26, CLEAN);
		expect(T260).toBeLessThan(0.5); // Hartley ozone band dominates
	});
});

describe('analyticalTransmission — water vapor bands', () => {
	it('high PWV crushes transmission at 1.38 µm', () => {
		const wet = analyticalTransmission(1.38, { ...CLEAN, pwvMm: 50 });
		const dry = analyticalTransmission(1.38, { ...CLEAN, pwvMm: 0 });
		expect(dry - wet).toBeGreaterThan(0.5);
		expect(wet).toBeLessThan(0.3);
	});

	it('PWV has negligible effect at 0.55 µm (no nearby band)', () => {
		const wet = analyticalTransmission(0.55, { ...CLEAN, pwvMm: 50 });
		const dry = analyticalTransmission(0.55, { ...CLEAN, pwvMm: 0 });
		expect(Math.abs(wet - dry)).toBeLessThan(0.02);
	});
});

describe('analyticalTransmission — aerosol extinction', () => {
	it('heavy AOD reduces visible transmission significantly', () => {
		const dirty = analyticalTransmission(0.55, { ...CLEAN, aod550: 1.5 });
		expect(dirty).toBeLessThan(0.3);
	});

	it('Ångström exponent shifts the spectral dependence', () => {
		// Higher α → steeper falloff into the SWIR, so SWIR less attenuated relative to vis.
		const inputLow = { ...CLEAN, aod550: 0.5, angstrom: 0.5 };
		const inputHigh = { ...CLEAN, aod550: 0.5, angstrom: 2.0 };
		const ratioLow = analyticalTransmission(2.0, inputLow) / analyticalTransmission(0.55, inputLow);
		const ratioHigh = analyticalTransmission(2.0, inputHigh) / analyticalTransmission(0.55, inputHigh);
		// Higher α → relatively more SWIR throughput vs vis.
		expect(ratioHigh).toBeGreaterThan(ratioLow);
	});
});

describe('analyticalTransmission — airmass scaling', () => {
	it('zenith=60 attenuates more than zenith=0', () => {
		const t0 = analyticalTransmission(0.55, CLEAN);
		const t60 = analyticalTransmission(0.55, { ...CLEAN, zenithDeg: 60 });
		expect(t60).toBeLessThan(t0);
	});
});

describe('analyticalSpectrum', () => {
	it('returns a vector matching the input grid', () => {
		const wl = [0.4, 0.55, 0.8, 1.6];
		const out = analyticalSpectrum(wl, CLEAN);
		expect(out).toHaveLength(wl.length);
		out.forEach((v) => {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		});
	});
});
