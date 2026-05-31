/**
 * Pure horizon-polygon geometry — the (azimuth, altitude) horizon
 * representation and the lookup that interpolates it at an arbitrary
 * azimuth.
 *
 * Extracted from `HorizonProvider` (which is Effect/terrain-fetch heavy)
 * so pure consumers — the sky compass, the transmission slant-path
 * geometry — can reuse the interpolation without dragging in the
 * elevation-lookup runtime. `HorizonProvider` re-exports these for
 * backward compatibility.
 */

export interface HorizonSample {
	readonly azimuthDeg: number;
	readonly altitudeDeg: number;
}

export type HorizonPolygon = readonly HorizonSample[];

/**
 * Look up the horizon altitude at a specific azimuth via linear
 * interpolation between the two nearest samples. Returns the
 * interpolated altitude in degrees. The polygon is assumed to be
 * sorted by azimuth ascending and to cover the full 0..360 range
 * (matching what `polygonAt` returns). An empty polygon yields a
 * flat-earth horizon (0°).
 */
export const horizonAtAzimuth = (polygon: HorizonPolygon, azimuthDeg: number): number => {
	if (polygon.length === 0) return 0;
	const az = ((azimuthDeg % 360) + 360) % 360;
	for (let i = 0; i < polygon.length; i++) {
		const a = polygon[i];
		const b = polygon[(i + 1) % polygon.length];
		const aAz = a.azimuthDeg;
		// Treat the last segment as wrapping past 360.
		const bAz = b.azimuthDeg <= aAz ? b.azimuthDeg + 360 : b.azimuthDeg;
		if (az >= aAz && az <= bAz) {
			const t = (az - aAz) / Math.max(1e-9, bAz - aAz);
			return a.altitudeDeg + t * (b.altitudeDeg - a.altitudeDeg);
		}
	}
	return polygon[0].altitudeDeg;
};
