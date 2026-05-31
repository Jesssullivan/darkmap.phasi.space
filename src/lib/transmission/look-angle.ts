/**
 * Resolve a transmission boresight from a chosen target.
 *
 * The user directs the beam one of four ways:
 *  - `zenith`  — straight up (the default; thinnest column).
 *  - `sun` / `moon` — aim at the body's current position, pulled from the
 *    per-pin ephemeris (alt-az for the selected point + time).
 *  - `manual`  — an explicit azimuth/elevation the user dialed in.
 *
 * Pure (no Effect, no network): given the body positions already computed
 * elsewhere, it picks the look-angle. The geometric-horizon case (body at
 * or below 0° altitude) is reported distinctly so the UI can say "below
 * the horizon" rather than silently computing a meaningless slant path.
 * Terrain occlusion is a separate concern handled by `checkOcclusion`.
 */

import type { BodyPosition } from '$lib/ephemeris/EphemerisClient';
import { type LookAngle, ZENITH, normalizeAzimuthDeg } from './slant-geometry';

export type LookTarget = 'zenith' | 'sun' | 'moon' | 'manual';

/** Body positions the resolver needs — a structural subset of `EphemerisReadout`. */
export interface BodyPositions {
	readonly sun: BodyPosition;
	readonly moon: BodyPosition;
}

export type LookAngleResolution =
	| { readonly kind: 'ok'; readonly lookAngle: LookAngle }
	| { readonly kind: 'below-horizon'; readonly lookAngle: LookAngle; readonly body: 'sun' | 'moon' };

/**
 * Resolve the boresight look-angle for `target`. `manual` is the angle the
 * user dialed (defaults to zenith upstream); `bodies` is the ephemeris
 * readout for the selected point + time, or `null` when it has not yet
 * resolved — in which case sun/moon targets fall back to the manual angle
 * so the UI stays usable while geometry loads.
 */
export const resolveLookAngle = (
	target: LookTarget,
	manual: LookAngle,
	bodies: BodyPositions | null,
): LookAngleResolution => {
	if (target === 'zenith') return { kind: 'ok', lookAngle: ZENITH };
	if (target === 'manual') return { kind: 'ok', lookAngle: manual };

	if (bodies === null) return { kind: 'ok', lookAngle: manual };
	const body = target === 'moon' ? bodies.moon : bodies.sun;
	const lookAngle: LookAngle = {
		azimuthDeg: normalizeAzimuthDeg(body.azimuthDeg),
		elevationDeg: body.altitudeDeg,
	};
	if (body.altitudeDeg <= 0) return { kind: 'below-horizon', lookAngle, body: target };
	return { kind: 'ok', lookAngle };
};
