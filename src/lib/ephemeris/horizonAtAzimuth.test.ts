import { describe, expect, it } from 'vitest';
import { type HorizonPolygon, horizonAtAzimuth } from './horizonAtAzimuth';

describe('horizonAtAzimuth', () => {
	const polygon: HorizonPolygon = [
		{ azimuthDeg: 0, altitudeDeg: 0 },
		{ azimuthDeg: 90, altitudeDeg: 10 },
		{ azimuthDeg: 180, altitudeDeg: 0 },
		{ azimuthDeg: 270, altitudeDeg: 20 },
	];

	it('returns 0 for an empty polygon (flat earth)', () => {
		expect(horizonAtAzimuth([], 123)).toBe(0);
	});

	it('returns the exact sample at a vertex azimuth', () => {
		expect(horizonAtAzimuth(polygon, 90)).toBeCloseTo(10, 6);
		expect(horizonAtAzimuth(polygon, 270)).toBeCloseTo(20, 6);
	});

	it('interpolates linearly between samples', () => {
		expect(horizonAtAzimuth(polygon, 45)).toBeCloseTo(5, 6);
		expect(horizonAtAzimuth(polygon, 135)).toBeCloseTo(5, 6);
	});

	it('wraps across the 270→0 segment past 360', () => {
		// Between az 270 (20°) and az 360≡0 (0°): the midpoint az 315 is half-way.
		expect(horizonAtAzimuth(polygon, 315)).toBeCloseTo(10, 6);
	});

	it('normalizes out-of-range azimuths', () => {
		expect(horizonAtAzimuth(polygon, 450)).toBeCloseTo(horizonAtAzimuth(polygon, 90), 6);
		expect(horizonAtAzimuth(polygon, -45)).toBeCloseTo(horizonAtAzimuth(polygon, 315), 6);
	});
});
