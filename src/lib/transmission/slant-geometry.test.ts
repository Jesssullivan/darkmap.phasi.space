import { describe, expect, it } from 'vitest';
import type { HorizonPolygon } from '$lib/ephemeris/horizonAtAzimuth';
import { ZENITH, checkOcclusion, elevationToZenithDeg, lookAngleAirmass, normalizeAzimuthDeg } from './slant-geometry';

describe('elevationToZenithDeg', () => {
	it('maps zenith (elev 90) to 0°', () => {
		expect(elevationToZenithDeg(90)).toBe(0);
	});
	it('maps the horizon (elev 0) to 90°', () => {
		expect(elevationToZenithDeg(0)).toBe(90);
	});
	it('maps 30° elevation to a 60° zenith angle', () => {
		expect(elevationToZenithDeg(30)).toBe(60);
	});
	it('clamps over-vertical elevation to 0°', () => {
		expect(elevationToZenithDeg(120)).toBe(0);
	});
	it('clamps below-horizon elevation to 90°', () => {
		expect(elevationToZenithDeg(-10)).toBe(90);
	});
});

describe('lookAngleAirmass', () => {
	it('is ~1.0 at the zenith', () => {
		const X = lookAngleAirmass(90);
		expect(X).not.toBeNull();
		expect(X!).toBeCloseTo(1.0, 3);
	});
	it('is ~2.0 at 30° elevation', () => {
		const X = lookAngleAirmass(30);
		expect(X).not.toBeNull();
		expect(X!).toBeCloseTo(2.0, 1);
	});
	it('is null at the horizon (elev 0) — diverges, meaningless', () => {
		expect(lookAngleAirmass(0)).toBeNull();
	});
	it('is null below the horizon', () => {
		expect(lookAngleAirmass(-5)).toBeNull();
	});
	it('decreases monotonically as elevation rises', () => {
		const samples = [10, 20, 40, 60, 80, 90].map((e) => lookAngleAirmass(e)!);
		for (let i = 1; i < samples.length; i++) {
			expect(samples[i]).toBeLessThan(samples[i - 1]);
		}
	});
});

describe('normalizeAzimuthDeg', () => {
	it('wraps negatives into [0, 360)', () => {
		expect(normalizeAzimuthDeg(-90)).toBe(270);
	});
	it('wraps values past 360', () => {
		expect(normalizeAzimuthDeg(450)).toBe(90);
	});
	it('leaves canonical values untouched', () => {
		expect(normalizeAzimuthDeg(180)).toBe(180);
	});
});

describe('checkOcclusion', () => {
	// A synthetic horizon: a 10° ridge to the east (az 90), flat elsewhere.
	const polygon: HorizonPolygon = [
		{ azimuthDeg: 0, altitudeDeg: 0 },
		{ azimuthDeg: 90, altitudeDeg: 10 },
		{ azimuthDeg: 180, altitudeDeg: 0 },
		{ azimuthDeg: 270, altitudeDeg: 0 },
	];

	it('reports occlusion when the boresight is below the ridge', () => {
		const r = checkOcclusion({ azimuthDeg: 90, elevationDeg: 5 }, polygon);
		expect(r.occluded).toBe(true);
		expect(r.horizonAltitudeDeg).toBeCloseTo(10, 5);
		expect(r.marginDeg).toBeCloseTo(-5, 5);
	});

	it('is clear when the boresight clears the ridge', () => {
		const r = checkOcclusion({ azimuthDeg: 90, elevationDeg: 15 }, polygon);
		expect(r.occluded).toBe(false);
		expect(r.marginDeg).toBeCloseTo(5, 5);
	});

	it('is clear over flat terrain just above 0°', () => {
		const r = checkOcclusion({ azimuthDeg: 270, elevationDeg: 1 }, polygon);
		expect(r.occluded).toBe(false);
		expect(r.horizonAltitudeDeg).toBeCloseTo(0, 5);
	});

	it('treats an empty polygon as a flat-earth horizon (not occluded above 0°)', () => {
		const r = checkOcclusion({ azimuthDeg: 123, elevationDeg: 1 }, []);
		expect(r.occluded).toBe(false);
		expect(r.horizonAltitudeDeg).toBe(0);
	});

	it('zenith clears any finite terrain horizon', () => {
		const r = checkOcclusion(ZENITH, polygon);
		expect(r.occluded).toBe(false);
	});
});
