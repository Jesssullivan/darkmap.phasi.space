import { describe, expect, it } from 'vitest';
import type { PollenReading } from '$lib/effect/services/AirQualityService';
import { pollenOpticalDepth } from './pollen-extinction';

const pollen = (over: Partial<PollenReading> = {}): PollenReading => ({
	alder: null,
	birch: null,
	grass: null,
	mugwort: null,
	olive: null,
	ragweed: null,
	...over,
});

describe('pollenOpticalDepth', () => {
	it('is zero with no reported pollen', () => {
		const r = pollenOpticalDepth(pollen());
		expect(r.tau).toBe(0);
		expect(r.negligible).toBe(true);
	});

	it('treats null and zero species as no contribution', () => {
		expect(pollenOpticalDepth(pollen({ grass: 0 })).tau).toBe(0);
	});

	it('yields a tiny τ even for a heavy grass count (≈1e-4)', () => {
		// 100 grains/m³, r=16µm, Q=2, H=1km → τ ≈ 100·2·π·(16e-6)²·1000 ≈ 1.6e-4.
		const r = pollenOpticalDepth(pollen({ grass: 100 }));
		expect(r.tau).toBeCloseTo(1.6e-4, 5);
		expect(r.negligible).toBe(true);
	});

	it('stays negligible even at an extreme birch bloom', () => {
		const r = pollenOpticalDepth(pollen({ birch: 5000 }));
		expect(r.tau).toBeLessThan(0.01);
		expect(r.negligible).toBe(true);
	});

	it('sums across species', () => {
		const single = pollenOpticalDepth(pollen({ grass: 100 })).tau;
		const both = pollenOpticalDepth(pollen({ grass: 100, birch: 100 })).tau;
		expect(both).toBeGreaterThan(single);
	});

	it('scales linearly with the assumed layer depth', () => {
		const a = pollenOpticalDepth(pollen({ grass: 100 }), { layerDepthM: 1000 }).tau;
		const b = pollenOpticalDepth(pollen({ grass: 100 }), { layerDepthM: 2000 }).tau;
		expect(b).toBeCloseTo(2 * a, 9);
	});
});
