/**
 * Atmospheric airmass for a body at a given altitude.
 *
 * Spectroscopy / dark-sky planners care about the air column the light
 * passes through. Plane-parallel approximation: airmass = sec(zenith)
 * — fine above ~30° altitude. Below that the atmosphere's curvature
 * starts mattering and we use Kasten & Young (1989), the de-facto
 * standard for ground-based observation planning:
 *
 *   X(z) = 1 / (cos(z) + 0.50572 * (96.07995 - z)^(-1.6364))
 *
 * where z is true zenith angle in degrees. Diverges past z ≈ 90°
 * (object below the horizon); we clamp to `null` there.
 *
 * For Bortle-class observers: X = 1 at the zenith, ~1.4 at 45° alt,
 * ~2 at 30° alt, ~5 at 10° alt, blowing up near the horizon.
 */

/**
 * Atmospheric airmass for a target at `altitudeDeg` above the horizon.
 * Returns `null` for targets at or below the geometric horizon
 * (altitudeDeg ≤ 0): airmass diverges and is observationally
 * meaningless.
 */
export const airmassKastenYoung = (altitudeDeg: number): number | null => {
	if (!Number.isFinite(altitudeDeg) || altitudeDeg <= 0) return null;
	const z = 90 - altitudeDeg;
	const cosZ = Math.cos((z * Math.PI) / 180);
	// Kasten & Young factor uses degrees, not radians.
	const factor = 0.50572 * Math.pow(96.07995 - z, -1.6364);
	const denom = cosZ + factor;
	if (denom <= 0) return null;
	return 1 / denom;
};

/**
 * Format airmass for compact display in the readout. "1.41" is plenty
 * of precision for planning; airmass < 10 is the useful range.
 */
export const formatAirmass = (X: number | null): string => {
	if (X === null) return '—';
	if (X >= 10) return '>10';
	return X.toFixed(2);
};
