/**
 * Horizon-aware twilight event refinement.
 *
 * Flat-horizon sunrise = the instant the sun's geocentric altitude
 * crosses 0°. That's what astronomy-engine's `SearchAltitude` /
 * `SearchRiseSet` return — and it's what the TimeHelix shows
 * today. For dark-sky / spectroscopy field work the answer that
 * actually matters is the instant the sun crosses the *local*
 * horizon at its azimuth, which is what a HorizonPolygon encodes.
 *
 * This helper takes a flat-horizon event time + a sun-position
 * sampler + a HorizonPolygon and refines the event to the true
 * crossing of (sun altitude - terrain altitude at sun azimuth)
 * via bisection over a ±2 h window. 8 iterations gets us to ~1 s
 * precision; we cap at 12 for safety.
 *
 * Twilight events (civil/nautical/astronomical) accept an
 * offsetDeg: target is when sun altitude = horizon altitude +
 * offsetDeg. For -6/-12/-18 twilights the sun-vs-terrain math
 * still applies (a -18° astronomical dawn is when the sun is
 * 18° below the *local* horizon at sun azimuth, not below the
 * geometric horizon plane). For most viewports the terrain
 * adjustment is small (~minutes) but it matters at the bottom of
 * a ravine or top of a peak.
 */

import { horizonAtAzimuth, type HorizonPolygon } from './HorizonProvider';
import type { BodyPosition, SkyPositions } from './EphemerisClient';

export type SunPositionFn = (t: Date) => BodyPosition;

export interface RefineOptions {
	/** Search window around the flat-horizon time. Default ±2 hours. */
	readonly windowMs?: number;
	/** Twilight target offset below local horizon. Default 0 (sunrise/sunset). */
	readonly offsetDeg?: number;
	/** Bisection bail-out resolution. Default 1 s. */
	readonly precisionMs?: number;
	/** Max bisection iterations. Default 12 (gives ~3 s precision over a 4 h window). */
	readonly maxIters?: number;
	/**
	 * Optional per-azimuth horizon polygon resolver. When provided, each
	 * bisection probe looks up the horizon altitude through this resolver
	 * with the sun's *current* azimuth — picking up the dense local fan
	 * from `HorizonProvider.polygonNearAzimuth` instead of the
	 * 10°-interpolated estimate the static polygon yields. When omitted,
	 * the function falls back to the static polygon argument.
	 *
	 * Callers typically pre-compute a small library of fans at strategic
	 * azimuths (e.g. the flat-event azimuth ±15° / ±30°) and have the
	 * resolver pick the closest. Returning the static polygon for
	 * unknown azimuths is a sound fallback.
	 */
	readonly polygonResolver?: (azimuthDeg: number) => HorizonPolygon;
}

const DEFAULT_OPTS: Omit<Required<RefineOptions>, 'polygonResolver'> = {
	windowMs: 2 * 3600 * 1000,
	offsetDeg: 0,
	precisionMs: 1000,
	maxIters: 12,
};

/**
 * Refine a single event time. Returns `null` if no crossing exists in
 * the search window (typical for polar locations near solstice, or for
 * twilight events that don't occur on a given day).
 */
export const refineHorizonEvent = (
	flatEventTime: Date,
	sunAt: SunPositionFn,
	polygon: HorizonPolygon,
	opts: RefineOptions = {},
): Date | null => {
	const o = { ...DEFAULT_OPTS, ...opts };
	const resolve = opts.polygonResolver;

	const f = (t: Date): number => {
		const p = sunAt(t);
		const localPolygon = resolve ? resolve(p.azimuthDeg) : polygon;
		const h = horizonAtAzimuth(localPolygon, p.azimuthDeg) + o.offsetDeg;
		return p.altitudeDeg - h;
	};

	let lo = flatEventTime.getTime() - o.windowMs;
	let hi = flatEventTime.getTime() + o.windowMs;
	let fLo = f(new Date(lo));
	let fHi = f(new Date(hi));

	if (fLo === 0) return new Date(lo);
	if (fHi === 0) return new Date(hi);
	if (fLo * fHi > 0) return null; // no sign-flip, no crossing in window

	for (let i = 0; i < o.maxIters; i++) {
		if (hi - lo <= o.precisionMs) break;
		const mid = Math.round((lo + hi) / 2);
		const fm = f(new Date(mid));
		if (fm === 0) return new Date(mid);
		if (fm * fLo < 0) {
			hi = mid;
			fHi = fm;
		} else {
			lo = mid;
			fLo = fm;
		}
	}
	return new Date(Math.round((lo + hi) / 2));
};

export interface FlatEventSet {
	readonly astronomicalDawn: Date | null;
	readonly nauticalDawn: Date | null;
	readonly civilDawn: Date | null;
	readonly sunrise: Date | null;
	readonly sunset: Date | null;
	readonly civilDusk: Date | null;
	readonly nauticalDusk: Date | null;
	readonly astronomicalDusk: Date | null;
}

/**
 * Refine every twilight event in a set against the local horizon. Solar
 * noon is unaffected (it's the meridian crossing, independent of
 * horizon). Returns the same shape with each event refined or `null`.
 */
export const refineEventSet = (
	flat: FlatEventSet,
	sunAt: SunPositionFn,
	polygon: HorizonPolygon,
	opts: Omit<RefineOptions, 'offsetDeg'> = {},
): FlatEventSet => {
	const refine = (t: Date | null, offsetDeg: number): Date | null =>
		t === null ? null : refineHorizonEvent(t, sunAt, polygon, { ...opts, offsetDeg });
	// `opts.polygonResolver` flows through implicitly via the spread above —
	// `refineHorizonEvent` reads it back off the options object.
	return {
		astronomicalDawn: refine(flat.astronomicalDawn, -18),
		nauticalDawn: refine(flat.nauticalDawn, -12),
		civilDawn: refine(flat.civilDawn, -6),
		sunrise: refine(flat.sunrise, 0),
		sunset: refine(flat.sunset, 0),
		civilDusk: refine(flat.civilDusk, -6),
		nauticalDusk: refine(flat.nauticalDusk, -12),
		astronomicalDusk: refine(flat.astronomicalDusk, -18),
	};
};

/**
 * Convenience: wrap an EphemerisClient's `positionAt` for callers that
 * already have one.
 */
export const sunPositionFromClient = (positionAt: (t: Date) => SkyPositions): SunPositionFn => {
	return (t) => positionAt(t).sun;
};
