/**
 * Slant-path geometry for a directable transmission boresight.
 *
 * The spectral-transmission model cares about the air column the beam
 * traverses. A boresight is a look-angle — an azimuth (compass bearing)
 * and an elevation above the horizon. Straight up (elevation 90°) is the
 * local zenith and the thinnest column; lower elevations punch through a
 * longer slant path and more atmosphere.
 *
 * This module is pure (no Effect, no network) so it unit-tests in
 * isolation. It deliberately delegates the two hard pieces to existing
 * primitives rather than re-deriving them:
 *
 *  - airmass → `airmassKastenYoung` (Kasten & Young 1989), the repo's
 *    standard ground-based airmass; `sec(z)` diverges near the horizon
 *    where curvature dominates, so we never use it.
 *  - terrain horizon altitude at an azimuth → `horizonAtAzimuth`, the
 *    same interpolation the sky-compass and pin-ephemeris consume.
 */

import { airmassKastenYoung } from '$lib/ephemeris/airmass';
import { horizonAtAzimuth, type HorizonPolygon } from '$lib/ephemeris/horizonAtAzimuth';

/** A pointing direction: compass azimuth + elevation above the horizon. */
export interface LookAngle {
	/** Compass bearing, 0 = north, clockwise. Canonical range [0, 360). */
	readonly azimuthDeg: number;
	/** Elevation above the horizon in degrees. 90 = local zenith. */
	readonly elevationDeg: number;
}

/** Straight up — the thinnest atmospheric column. */
export const ZENITH: LookAngle = { azimuthDeg: 0, elevationDeg: 90 };

/** Wrap any azimuth into the canonical [0, 360) range. */
export const normalizeAzimuthDeg = (azimuthDeg: number): number => ((azimuthDeg % 360) + 360) % 360;

/**
 * Zenith angle (from straight up) for a boresight at `elevationDeg`.
 * `zenith = 90 - elevation`, clamped to the physical [0, 90] range so a
 * below-horizon or over-vertical input still maps to a usable LUT axis
 * value. The transmission LUT brackets/clamps zenith to its [0, 75] axis
 * downstream, so steep look-angles are safe (they reuse the 75° row — a
 * known V0 LUT limitation, not introduced here).
 */
export const elevationToZenithDeg = (elevationDeg: number): number => Math.min(90, Math.max(0, 90 - elevationDeg));

/**
 * Relative airmass along the slant path for a boresight at
 * `elevationDeg`. Delegates to Kasten & Young (1989) via
 * `airmassKastenYoung` (which takes altitude-above-horizon, exactly our
 * elevation). Returns `null` when elevation ≤ 0 — the path grazes or
 * exits the geometric horizon, where airmass diverges and is meaningless.
 */
export const lookAngleAirmass = (elevationDeg: number): number | null => airmassKastenYoung(elevationDeg);

/** Whether the boresight is blocked by local terrain, and by how much. */
export interface OcclusionResult {
	/** True when the look elevation is below the interpolated terrain horizon. */
	readonly occluded: boolean;
	/** Terrain horizon altitude (deg) at the boresight azimuth. */
	readonly horizonAltitudeDeg: number;
	/** `elevation - horizonAltitude`; negative when occluded. */
	readonly marginDeg: number;
}

/**
 * Determine whether a boresight is occluded by the local terrain
 * horizon. Reuses `horizonAtAzimuth` to interpolate the DEM-derived
 * horizon polygon at the look azimuth, then compares it to the look
 * elevation. An empty polygon yields a flat-earth horizon (0°), so the
 * safe default when terrain is unknown is "not occluded above 0°".
 */
export const checkOcclusion = (lookAngle: LookAngle, polygon: HorizonPolygon): OcclusionResult => {
	const horizonAltitudeDeg = horizonAtAzimuth(polygon, lookAngle.azimuthDeg);
	const marginDeg = lookAngle.elevationDeg - horizonAltitudeDeg;
	return { occluded: marginDeg < 0, horizonAltitudeDeg, marginDeg };
};
