import { describe, expect, it } from 'vitest';
import { AOD550_AXIS } from '$lib/spectral/transmission-axes';
import {
	DEFAULT_DIFFUSION,
	estimatePm25At,
	formatNearestKm,
	formatStationCount,
	haversineKm,
	pm25AqiCategory,
	pm25ToAod550,
	PM25_TO_AOD550_FACTOR,
	type Pm25Station,
} from './pm25-diffusion';

const station = (lon: number, lat: number, value: number | null): Pm25Station => ({ lon, lat, value });

/* --------------------------- coverage phrasing --------------------------- */

describe('formatStationCount', () => {
	it('singular for one station, plural otherwise', () => {
		expect(formatStationCount(1)).toBe('1 station');
		expect(formatStationCount(0)).toBe('0 stations');
		expect(formatStationCount(3)).toBe('3 stations');
	});
});

describe('formatNearestKm', () => {
	it('returns null when no station is in range', () => {
		expect(formatNearestKm(null)).toBeNull();
	});
	it('clamps sub-kilometre distances to "<1" and rounds the rest', () => {
		expect(formatNearestKm(0.4)).toBe('nearest <1 km');
		expect(formatNearestKm(4.6)).toBe('nearest 5 km');
	});
});

describe('pm25AqiCategory', () => {
	it('maps µg/m³ to US-AQI category labels at the breakpoints', () => {
		expect(pm25AqiCategory(5)).toBe('Good');
		expect(pm25AqiCategory(20)).toBe('Moderate');
		expect(pm25AqiCategory(40)).toBe('Unhealthy for sensitive groups');
		expect(pm25AqiCategory(100)).toBe('Unhealthy');
		expect(pm25AqiCategory(200)).toBe('Very unhealthy');
		expect(pm25AqiCategory(300)).toBe('Hazardous');
	});
});

/* ------------------------------ haversine ------------------------------ */

describe('haversineKm', () => {
	it('is ~0 for identical points', () => {
		expect(haversineKm(-100, 40, -100, 40)).toBeCloseTo(0, 6);
	});

	it('≈111 km for 1° of latitude', () => {
		expect(haversineKm(-100, 40, -100, 41)).toBeGreaterThan(110);
		expect(haversineKm(-100, 40, -100, 41)).toBeLessThan(112);
	});

	it('is symmetric', () => {
		const a = haversineKm(-74, 40.7, -73, 41);
		const b = haversineKm(-73, 41, -74, 40.7);
		expect(a).toBeCloseTo(b, 9);
	});
});

/* --------------------------- estimatePm25At --------------------------- */

describe('estimatePm25At — dense coverage', () => {
	it('returns ~the local value with high confidence when several stations surround the point', () => {
		// 5 stations within a few km, all reading ~20 µg/m³.
		const stations = [
			station(-100.0, 40.0, 20),
			station(-100.02, 40.0, 21),
			station(-99.98, 40.0, 19),
			station(-100.0, 40.02, 20),
			station(-100.0, 39.98, 20),
		];
		const est = estimatePm25At(stations, -100, 40);
		expect(est.valueUgm3).not.toBeNull();
		expect(est.valueUgm3!).toBeGreaterThan(19);
		expect(est.valueUgm3!).toBeLessThan(21);
		expect(est.confidence).toBe('high');
		expect(est.effectiveStations).toBeGreaterThanOrEqual(DEFAULT_DIFFUSION.minEffectiveStationsHigh);
		expect(est.contributingStations).toBe(5);
		expect(est.nearestKm).toBeCloseTo(0, 5);
	});
});

describe('estimatePm25At — sparse coverage', () => {
	it('returns the lone station value but flags low confidence (effective N ≈ 1)', () => {
		const stations = [station(-100.1, 40.05, 42)];
		const est = estimatePm25At(stations, -100, 40);
		expect(est.valueUgm3).toBeCloseTo(42, 6);
		expect(est.confidence).toBe('low');
		expect(est.effectiveStations).toBeCloseTo(1, 6);
		expect(est.contributingStations).toBe(1);
		expect(est.nearestKm!).toBeGreaterThan(0);
	});
});

describe('estimatePm25At — null handling', () => {
	it('excludes null-value stations entirely (never treated as 0)', () => {
		// One real reading of 30 surrounded by null stations — the estimate
		// must be 30, NOT pulled toward 0 by the nulls.
		const stations = [
			station(-100.0, 40.0, 30),
			station(-100.01, 40.0, null),
			station(-99.99, 40.0, null),
			station(-100.0, 40.01, null),
		];
		const est = estimatePm25At(stations, -100, 40);
		expect(est.valueUgm3).toBeCloseTo(30, 6);
		expect(est.contributingStations).toBe(1);
		expect(est.confidence).toBe('low'); // only one real reading supports it
	});

	it('returns none when every station is null', () => {
		const stations = [station(-100, 40, null), station(-100.01, 40, null)];
		const est = estimatePm25At(stations, -100, 40);
		expect(est.valueUgm3).toBeNull();
		expect(est.confidence).toBe('none');
		expect(est.effectiveStations).toBe(0);
		expect(est.nearestKm).toBeNull();
		expect(est.contributingStations).toBe(0);
	});
});

describe('estimatePm25At — out of range', () => {
	it('returns none when all stations are beyond the cutoff radius (no fabrication)', () => {
		// Station ~480 km away (4°+ of latitude) — beyond the 75 km cutoff.
		const stations = [station(-100, 35, 50)];
		const est = estimatePm25At(stations, -100, 40);
		expect(est.valueUgm3).toBeNull();
		expect(est.confidence).toBe('none');
		expect(est.contributingStations).toBe(0);
		expect(est.nearestKm).toBeNull();
	});

	it('empty station list → none', () => {
		const est = estimatePm25At([], -100, 40);
		expect(est.valueUgm3).toBeNull();
		expect(est.confidence).toBe('none');
	});
});

describe('estimatePm25At — distance weighting', () => {
	it('pulls the estimate toward the nearer station', () => {
		// Near station (≈5 km, value 10) vs far station (≈40 km, value 50).
		const stations = [station(-100.06, 40.0, 10), station(-100.0, 40.36, 50)];
		const est = estimatePm25At(stations, -100, 40);
		expect(est.valueUgm3).not.toBeNull();
		// Gaussian weighting → much closer to the near station's 10 than the midpoint 30.
		expect(est.valueUgm3!).toBeLessThan(20);
	});

	it('a tighter bandwidth concentrates weight on the nearest station', () => {
		const stations = [station(-100.06, 40.0, 10), station(-100.0, 40.18, 50)];
		const wide = estimatePm25At(stations, -100, 40, { ...DEFAULT_DIFFUSION, bandwidthKm: 40 });
		const tight = estimatePm25At(stations, -100, 40, { ...DEFAULT_DIFFUSION, bandwidthKm: 8 });
		// Tighter kernel weights the near (10) station more, so its estimate is lower.
		expect(tight.valueUgm3!).toBeLessThan(wide.valueUgm3!);
	});
});

/* ----------------------------- pm25ToAod550 ----------------------------- */

describe('pm25ToAod550', () => {
	const AOD_MAX = AOD550_AXIS[AOD550_AXIS.length - 1];

	it('null → null (no reading is not zero aerosol)', () => {
		expect(pm25ToAod550(null)).toBeNull();
	});

	it('0 → 0', () => {
		expect(pm25ToAod550(0)).toBe(0);
	});

	it('applies the documented first-order factor', () => {
		expect(pm25ToAod550(10)).toBeCloseTo(10 * PM25_TO_AOD550_FACTOR, 9);
	});

	it('is monotonically increasing below the clamp', () => {
		expect(pm25ToAod550(20)!).toBeGreaterThan(pm25ToAod550(10)!);
	});

	it('clamps to the LUT AOD550 axis max so interpolation never extrapolates off-grid', () => {
		expect(pm25ToAod550(100_000)).toBe(AOD_MAX);
	});

	it('treats a negative reading as 0 floor', () => {
		expect(pm25ToAod550(-5)).toBe(0);
	});
});
