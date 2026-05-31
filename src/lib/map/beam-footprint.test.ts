import { describe, expect, it } from 'vitest';
import { beamCenterline, beamSamplePoints, beamSectorPolygon, type BeamParams } from './beam-footprint';

const origin = { lon: 8.55, lat: 47.36 };

const haversineKm = (a: number[], b: number[]): number => {
	const R = 6371;
	const dLat = ((b[1] - a[1]) * Math.PI) / 180;
	const dLon = ((b[0] - a[0]) * Math.PI) / 180;
	const la1 = (a[1] * Math.PI) / 180;
	const la2 = (b[1] * Math.PI) / 180;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
};

const bearingDeg = (a: number[], b: number[]): number => {
	const la1 = (a[1] * Math.PI) / 180;
	const la2 = (b[1] * Math.PI) / 180;
	const dLon = ((b[0] - a[0]) * Math.PI) / 180;
	const y = Math.sin(dLon) * Math.cos(la2);
	const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
	return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

const params = (over: Partial<BeamParams> = {}): BeamParams => ({
	origin,
	azimuthDeg: 90,
	beamwidthDeg: 30,
	rangeKm: 10,
	...over,
});

describe('beamSectorPolygon', () => {
	it('is a closed ring starting and ending at the origin', () => {
		const poly = beamSectorPolygon(params(), 16);
		const ring = poly.coordinates[0];
		expect(ring[0]).toEqual([origin.lon, origin.lat]);
		expect(ring[ring.length - 1]).toEqual([origin.lon, origin.lat]);
		// origin + (steps+1) arc points + origin
		expect(ring.length).toBe(16 + 1 + 2);
	});

	it('puts arc vertices ~rangeKm from the origin', () => {
		const ring = beamSectorPolygon(params({ rangeKm: 12 }), 8).coordinates[0];
		// skip the leading/trailing origin vertices
		for (const v of ring.slice(1, -1)) {
			expect(haversineKm([origin.lon, origin.lat], v)).toBeCloseTo(12, 1);
		}
	});

	it('spans the beamwidth centred on the azimuth', () => {
		const ring = beamSectorPolygon(params({ azimuthDeg: 90, beamwidthDeg: 40 }), 32).coordinates[0];
		const arc = ring.slice(1, -1);
		const first = bearingDeg([origin.lon, origin.lat], arc[0]);
		const last = bearingDeg([origin.lon, origin.lat], arc[arc.length - 1]);
		expect(first).toBeCloseTo(70, 0); // 90 - 20
		expect(last).toBeCloseTo(110, 0); // 90 + 20
	});
});

describe('beamSamplePoints', () => {
	it('returns n+1 points from the origin to the far end', () => {
		const pts = beamSamplePoints(params({ rangeKm: 30 }), 6);
		expect(pts.length).toBe(7);
		expect(pts[0].lon).toBeCloseTo(origin.lon, 9);
		expect(pts[0].lat).toBeCloseTo(origin.lat, 9);
		expect(haversineKm([origin.lon, origin.lat], [pts[6].lon, pts[6].lat])).toBeCloseTo(30, 1);
	});

	it('spaces samples evenly along the centerline', () => {
		const pts = beamSamplePoints(params({ rangeKm: 40 }), 4);
		const d = (i: number) => haversineKm([origin.lon, origin.lat], [pts[i].lon, pts[i].lat]);
		expect(d(1)).toBeCloseTo(10, 1);
		expect(d(2)).toBeCloseTo(20, 1);
		expect(d(3)).toBeCloseTo(30, 1);
	});
});

describe('beamCenterline', () => {
	it('runs from the origin along the azimuth for rangeKm', () => {
		const line = beamCenterline(params({ azimuthDeg: 45, rangeKm: 25 }));
		expect(line.coordinates[0]).toEqual([origin.lon, origin.lat]);
		expect(haversineKm(line.coordinates[0], line.coordinates[1])).toBeCloseTo(25, 1);
		expect(bearingDeg(line.coordinates[0], line.coordinates[1])).toBeCloseTo(45, 0);
	});
});
