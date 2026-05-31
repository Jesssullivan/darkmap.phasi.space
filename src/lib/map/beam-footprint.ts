/**
 * Beam footprint — the directable-area visualization (V3-7).
 *
 * Given the transmission boresight (origin + azimuth) plus a beamwidth and
 * range, produce GeoJSON for a sector "footprint" + a centerline to draw on the
 * map. Pure geometry, no MapLibre — unit-testable in isolation.
 *
 * GeoJSON types are inlined because the repo has no `@types/geojson`. The
 * forward-geodesic mirrors `ephemeris/terrarium.destinationPoint`; it is inlined
 * here so this map module's test slice stays dependency-free.
 */

export interface LonLat {
	readonly lon: number;
	readonly lat: number;
}

export interface GeoJSONPolygon {
	readonly type: 'Polygon';
	readonly coordinates: number[][][];
}

export interface GeoJSONLineString {
	readonly type: 'LineString';
	readonly coordinates: number[][];
}

export interface BeamParams {
	readonly origin: LonLat;
	/** Boresight compass bearing, 0 = north, clockwise. */
	readonly azimuthDeg: number;
	/** Full angular width of the sector (degrees). */
	readonly beamwidthDeg: number;
	/** Sector radius (km). */
	readonly rangeKm: number;
}

const R_EARTH_M = 6_371_000;

/** Destination point along `bearingDeg` at `distanceM` from (lat, lon). */
const destination = (lat: number, lon: number, bearingDeg: number, distanceM: number): LonLat => {
	const lat1 = (lat * Math.PI) / 180;
	const lon1 = (lon * Math.PI) / 180;
	const brg = (bearingDeg * Math.PI) / 180;
	const dr = distanceM / R_EARTH_M;
	const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(brg));
	const lon2 =
		lon1 + Math.atan2(Math.sin(brg) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
	return { lat: (lat2 * 180) / Math.PI, lon: (((lon2 * 180) / Math.PI + 540) % 360) - 180 };
};

/**
 * A closed sector polygon: origin → arc swept across the beamwidth centred on
 * the azimuth at `rangeKm` → back to origin. `arcSteps` segments the arc.
 */
export const beamSectorPolygon = (p: BeamParams, arcSteps = 48): GeoJSONPolygon => {
	const steps = Math.max(1, Math.floor(arcSteps));
	const half = p.beamwidthDeg / 2;
	const distM = p.rangeKm * 1000;
	const ring: number[][] = [[p.origin.lon, p.origin.lat]];
	for (let i = 0; i <= steps; i++) {
		const az = p.azimuthDeg - half + (p.beamwidthDeg * i) / steps;
		const d = destination(p.origin.lat, p.origin.lon, az, distM);
		ring.push([d.lon, d.lat]);
	}
	ring.push([p.origin.lon, p.origin.lat]);
	return { type: 'Polygon', coordinates: [ring] };
};

/** The boresight centerline: origin → range along the azimuth. */
export const beamCenterline = (p: BeamParams): GeoJSONLineString => {
	const d = destination(p.origin.lat, p.origin.lon, p.azimuthDeg, p.rangeKm * 1000);
	return {
		type: 'LineString',
		coordinates: [
			[p.origin.lon, p.origin.lat],
			[d.lon, d.lat],
		],
	};
};
