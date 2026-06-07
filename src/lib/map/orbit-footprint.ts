/**
 * Orbit ground-footprint — the sub-satellite coverage overlay (S3, PR2b).
 *
 * Given an SGP4 satrec + an instant, project the satellite's sub-point to the
 * surface and draw the instantaneous ground-coverage circle (the area within
 * which the satellite clears the 0° geometric horizon) plus the nadir dot.
 * Pure geometry, no MapLibre — composes the SHIPPED orbit helpers
 * (subSatellitePoint / footprintRadiusKm / geodesicRing) so it stays in the
 * node-safe map test slice.
 *
 * Honesty (the V6 bar): the circle is the 0° GEOMETRIC horizon, not a
 * comms/elevation-masked service area, and it's INSTANTANEOUS for `atDate`.
 * If SGP4 yields no sub-point we return null (honest no-draw — never fabricate).
 *
 * GeoJSON types are inlined (the repo has no `@types/geojson`), mirroring
 * `beam-footprint.ts`.
 */
import { footprintRadiusKm, geodesicRing, subSatellitePoint } from '$lib/orbit';
import type { SatRec } from 'satellite.js';

export interface GeoJSONPolygon {
	readonly type: 'Polygon';
	readonly coordinates: number[][][];
}

export interface GeoJSONPoint {
	readonly type: 'Point';
	readonly coordinates: number[];
}

/** Footprint ring carries its geometry params so the layer/legend can read them. */
export interface FootprintProperties {
	readonly kind: 'footprint';
	/** Sub-satellite geodetic altitude, km. */
	readonly altitudeKm: number;
	/** Surface radius of the coverage circle, km. */
	readonly radiusKm: number;
}

export interface NadirProperties {
	readonly kind: 'nadir';
}

export interface FootprintFeature {
	readonly type: 'Feature';
	readonly geometry: GeoJSONPolygon;
	readonly properties: FootprintProperties;
}

export interface NadirFeature {
	readonly type: 'Feature';
	readonly geometry: GeoJSONPoint;
	readonly properties: NadirProperties;
}

export interface FootprintFeatureCollection {
	readonly type: 'FeatureCollection';
	readonly features: (FootprintFeature | NadirFeature)[];
}

/**
 * Closed great-circle coverage ring (Polygon) + the nadir Point at the
 * satellite's sub-point for `atDate`. Returns null on SGP4 error / no geodetic
 * fix (honest no-draw). The ring is sampled at 64 segments (65 vertices, first
 * repeated to close) via the shipped `geodesicRing` so the ~2300 km footprint
 * isn't distorted at high latitude.
 */
export function footprintFeatureCollection(satrec: SatRec, atDate: Date): FootprintFeatureCollection | null {
	const sub = subSatellitePoint(satrec, atDate);
	if (!sub) return null;
	const radiusKm = footprintRadiusKm(sub.altitudeKm);
	const ring = geodesicRing(sub.latDeg, sub.lonDeg, radiusKm, 64);
	return {
		type: 'FeatureCollection',
		features: [
			{
				type: 'Feature',
				geometry: { type: 'Polygon', coordinates: [ring] },
				properties: { kind: 'footprint', altitudeKm: sub.altitudeKm, radiusKm },
			},
			{
				type: 'Feature',
				geometry: { type: 'Point', coordinates: [sub.lonDeg, sub.latDeg] },
				properties: { kind: 'nadir' },
			},
		],
	};
}

/** Just the nadir Point at the sub-satellite point for `atDate`, or null on SGP4 error. */
export function subSatelliteMarkerFeature(satrec: SatRec, atDate: Date): NadirFeature | null {
	const sub = subSatellitePoint(satrec, atDate);
	if (!sub) return null;
	return {
		type: 'Feature',
		geometry: { type: 'Point', coordinates: [sub.lonDeg, sub.latDeg] },
		properties: { kind: 'nadir' },
	};
}
