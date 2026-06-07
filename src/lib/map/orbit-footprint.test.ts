import { describe, expect, it } from 'vitest';
import { EARTH_RADIUS_KM, footprintRadiusKm, parseTle } from '$lib/orbit';
import { footprintFeatureCollection, subSatelliteMarkerFeature } from './orbit-footprint';

// The same real ISS (ZARYA) TLE the orbit slice uses, epoch 2020-060.85.
const L1 = '1 25544U 98067A   20060.85138889  .00000737  00000-0  21434-4 0  9996';
const L2 = '2 25544  51.6432  21.4250 0005140  30.2069  84.7649 15.49180547215146';
const AT = new Date('2020-03-01T21:00:00Z'); // just after the TLE epoch
// ~30000 days past epoch: SGP4 reports the orbit decayed below the surface
// (error code 6 → boolean position), the path `subSatellitePoint` returns null
// for. A real propagation, not an injected satrec field — honest no-draw.
const DECAYED_AT = new Date(AT.getTime() + 30_000 * 86_400_000);

// Haversine surface distance (km) — the great-circle radius check for the ring.
const haversineKm = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
	const r = Math.PI / 180;
	const dLat = (bLat - aLat) * r;
	const dLon = (bLon - aLon) * r;
	const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
	return EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(s));
};

describe('footprintFeatureCollection', () => {
	it('returns null when SGP4 yields no sub-point (decayed orbit)', () => {
		const { satrec } = parseTle(L1, L2);
		expect(footprintFeatureCollection(satrec, DECAYED_AT)).toBeNull();
	});

	it('a valid pass yields a closed 65-vertex ring (64 segments) + a nadir point', () => {
		const { satrec } = parseTle(L1, L2);
		const fc = footprintFeatureCollection(satrec, AT);
		expect(fc).not.toBeNull();
		expect(fc!.type).toBe('FeatureCollection');

		const poly = fc!.features.find((f) => f.properties.kind === 'footprint');
		const nadir = fc!.features.find((f) => f.properties.kind === 'nadir');
		expect(poly).toBeDefined();
		expect(nadir).toBeDefined();

		const ring = (poly!.geometry as { type: 'Polygon'; coordinates: number[][][] }).coordinates[0];
		expect(ring).toHaveLength(65); // 64 segments, first vertex repeated to close
		expect(ring[0][0]).toBeCloseTo(ring[64][0], 6);
		expect(ring[0][1]).toBeCloseTo(ring[64][1], 6);

		expect((nadir!.geometry as { type: 'Point'; coordinates: number[] }).type).toBe('Point');
	});

	it('every ring vertex sits ~footprintRadiusKm(alt) from the nadir (great-circle)', () => {
		const { satrec } = parseTle(L1, L2);
		const fc = footprintFeatureCollection(satrec, AT)!;
		const poly = fc.features.find((f) => f.properties.kind === 'footprint')!;
		const nadir = fc.features.find((f) => f.properties.kind === 'nadir')!;
		const [nLon, nLat] = (nadir.geometry as { coordinates: number[] }).coordinates;
		const props = poly.properties as { altitudeKm: number; radiusKm: number };
		const expectedKm = footprintRadiusKm(props.altitudeKm);
		expect(props.radiusKm).toBeCloseTo(expectedKm, 6);

		const ring = (poly.geometry as { coordinates: number[][][] }).coordinates[0];
		for (const [lon, lat] of ring) {
			expect(haversineKm(nLat, nLon, lat, lon)).toBeCloseTo(expectedKm, 0); // within ~1 km
		}
	});

	it('properties carry the sub-satellite altitudeKm + footprint radiusKm (LEO sanity)', () => {
		const { satrec } = parseTle(L1, L2);
		const fc = footprintFeatureCollection(satrec, AT)!;
		const props = fc.features.find((f) => f.properties.kind === 'footprint')!.properties as {
			altitudeKm: number;
			radiusKm: number;
		};
		expect(props.altitudeKm).toBeGreaterThan(300); // ISS is LEO
		expect(props.altitudeKm).toBeLessThan(500);
		expect(props.radiusKm).toBeGreaterThan(2000); // ~2300 km footprint at ~420 km
		expect(props.radiusKm).toBeLessThan(2500);
	});
});

describe('subSatelliteMarkerFeature', () => {
	it('returns the nadir Point for a valid pass', () => {
		const { satrec } = parseTle(L1, L2);
		const feat = subSatelliteMarkerFeature(satrec, AT);
		expect(feat).not.toBeNull();
		expect(feat!.geometry.type).toBe('Point');
		expect(feat!.properties.kind).toBe('nadir');
		const [lon, lat] = feat!.geometry.coordinates;
		expect(lon).toBeGreaterThanOrEqual(-180);
		expect(lon).toBeLessThan(180);
		expect(Math.abs(lat)).toBeLessThanOrEqual(52); // ISS inclination 51.6°
	});

	it('returns null when SGP4 yields no sub-point (decayed orbit)', () => {
		const { satrec } = parseTle(L1, L2);
		expect(subSatelliteMarkerFeature(satrec, DECAYED_AT)).toBeNull();
	});
});
