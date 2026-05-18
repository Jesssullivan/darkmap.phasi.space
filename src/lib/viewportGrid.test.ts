import { describe, expect, it } from 'vitest';
import { viewportGridPoints } from './viewportGrid';

describe('viewportGridPoints', () => {
	it('emits samples × samples points for a normal viewport', () => {
		const pts = viewportGridPoints({ north: 50, south: 40, east: -70, west: -80 }, 4);
		expect(pts).toHaveLength(16);
	});

	it('places the first point near the SW corner', () => {
		const pts = viewportGridPoints({ north: 50, south: 40, east: -70, west: -80 }, 4);
		// Quarter-cell inset from south + west.
		expect(pts[0].lat).toBeCloseTo(41.25, 6);
		expect(pts[0].lon).toBeCloseTo(-78.75, 6);
	});

	it('places the last point near the NE corner', () => {
		const pts = viewportGridPoints({ north: 50, south: 40, east: -70, west: -80 }, 4);
		expect(pts[pts.length - 1].lat).toBeCloseTo(48.75, 6);
		expect(pts[pts.length - 1].lon).toBeCloseTo(-71.25, 6);
	});

	it('returns [] for a degenerate latitude span', () => {
		expect(viewportGridPoints({ north: 50, south: 50, east: 10, west: -10 }, 4)).toEqual([]);
	});

	it('returns [] for zero longitude span (same east + west)', () => {
		expect(viewportGridPoints({ north: 50, south: 40, east: 10, west: 10 }, 4)).toEqual([]);
	});

	it('handles antimeridian crossings: east < west wraps around the dateline', () => {
		// 170°E → 170°W is a 20° span across the dateline, not -340°.
		const pts = viewportGridPoints({ north: 1, south: -1, east: -170, west: 170 }, 4);
		expect(pts).toHaveLength(16);
		// All longitudes should be in (-180, 180]. With a 20° span starting
		// at 170, the (3.5/4 of 20)=17.5° sample is 187.5° raw → canonicalized
		// to -172.5° (just past the dateline).
		for (const p of pts) {
			expect(p.lon).toBeGreaterThan(-180);
			expect(p.lon).toBeLessThanOrEqual(180);
		}
		// The eastmost sample should sit on the eastern (negative) side.
		const eastmost = pts.filter((p) => p.lat === pts[0].lat).at(-1)!;
		expect(eastmost.lon).toBeLessThan(0);
	});

	it('canonical lon span for a 360° viewport touches every quadrant', () => {
		const pts = viewportGridPoints({ north: 1, south: -1, east: 180, west: -180 }, 4);
		const lons = pts.filter((p) => p.lat === pts[0].lat).map((p) => p.lon);
		expect(lons).toHaveLength(4);
		expect(lons[0]).toBeLessThan(0);
		expect(lons[3]).toBeGreaterThan(0);
	});

	it('respects custom sample counts', () => {
		const pts = viewportGridPoints({ north: 1, south: 0, east: 1, west: 0 }, 3);
		expect(pts).toHaveLength(9);
	});

	it('treats invalid samples < 1 as zero-grid', () => {
		expect(viewportGridPoints({ north: 1, south: 0, east: 1, west: 0 }, 0)).toEqual([]);
		expect(viewportGridPoints({ north: 1, south: 0, east: 1, west: 0 }, -2)).toEqual([]);
	});
});
