/**
 * Per-pin horizon-aware ephemeris — the "lighthouse" feature.
 *
 * Given a clicked map point + a date, computes:
 *
 *  1. The flat-horizon readout from astronomy-engine (sun/moon position,
 *     standard sunrise/sunset/twilight events).
 *  2. The local horizon polygon — terrain altitude at 36 azimuths via
 *     Mapzen Terrarium elevation tiles, accounting for earth curvature
 *     and refraction.
 *  3. The horizon-aware refinement — every twilight event re-bisected
 *     against the true local horizon at the sun's actual azimuth.
 *
 * Result: a `PinEphemerisReadout` carrying both the flat and refined
 * event sets so callers can show users the terrain delta ("astro dawn
 * 04:32 UTC flat / 04:41 UTC behind the ridge to the east").
 *
 * Memoised per (lat3, lon3, day) — clicking the same pin twice in the
 * same UTC day hits cache. The tile cache inside
 * `TerrariumElevationLookupLive` survives across pins, so even cold
 * lookups reuse decoded Terrarium tiles.
 */

import { Effect, Layer } from 'effect';
import { EphemerisClient, EphemerisClientLive, type EphemerisReadout, type LatLon } from './EphemerisClient';
import { HorizonProvider, HorizonProviderLive, type HorizonPolygon } from './HorizonProvider';
import { refineEventSet, sunPositionFromClient, type FlatEventSet } from './horizonAwareEvents';
import { TerrariumElevationLookupLive } from './TerrariumElevationLookup';

export interface PinEphemerisReadout {
	readonly location: LatLon;
	readonly at: Date;
	readonly flat: EphemerisReadout;
	readonly polygon: HorizonPolygon;
	readonly refined: FlatEventSet;
}

const cacheKey = (loc: LatLon, t: Date): string => {
	const lat = loc.lat.toFixed(3);
	const lon = loc.lon.toFixed(3);
	const day = `${t.getUTCFullYear()}-${t.getUTCMonth()}-${t.getUTCDate()}`;
	return `${lat},${lon}|${day}`;
};

const memo = new Map<string, Promise<PinEphemerisReadout>>();

/**
 * Build a `PinEphemerisReadout` for `loc` at instant `t`. Memoised per
 * (lat3, lon3, UTC-day). Returns a Promise the caller can await
 * directly — internally provides the full Layer stack (EphemerisClient
 * + HorizonProvider + ElevationLookup).
 */
export const computePinEphemeris = (loc: LatLon, t: Date): Promise<PinEphemerisReadout> => {
	const key = cacheKey(loc, t);
	const hit = memo.get(key);
	if (hit) return hit;
	const promise = Effect.runPromise(
		Effect.gen(function* () {
			const eph = yield* EphemerisClient;
			const horizon = yield* HorizonProvider;
			const flat = yield* eph.at(loc, t);
			const polygon = yield* horizon.polygonAt(loc);
			const sunFn = sunPositionFromClient((time) => Effect.runSync(eph.positionAt(loc, time)));
			const refined = refineEventSet(flat.events as FlatEventSet, sunFn, polygon);
			return {
				location: loc,
				at: t,
				flat,
				polygon,
				refined,
			} satisfies PinEphemerisReadout;
		}).pipe(
			Effect.provide(
				Layer.mergeAll(EphemerisClientLive, Layer.provide(HorizonProviderLive, TerrariumElevationLookupLive)),
			),
		),
	);
	memo.set(key, promise);
	// If the underlying computation rejects (e.g. elevation tile fetch
	// flake), evict the failed entry so the next click retries instead
	// of pinning the failure for the remainder of the session.
	promise.catch(() => {
		if (memo.get(key) === promise) memo.delete(key);
	});
	return promise;
};

/**
 * Test-seam: lets vitest reset memo state between cases. Production
 * code should never call this; the cache is module-private by design.
 */
export const _resetPinEphemerisMemo = (): void => {
	memo.clear();
};

/**
 * Test-seam: same as `computePinEphemeris` but lets the caller swap in
 * a custom `HorizonProvider` Layer (e.g. with a stub `ElevationLookup`)
 * to avoid real network I/O. Bypasses the memo cache.
 */
export const computePinEphemerisWithLayer = (
	loc: LatLon,
	t: Date,
	horizonLayer: Layer.Layer<HorizonProvider>,
): Promise<PinEphemerisReadout> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const eph = yield* EphemerisClient;
			const horizon = yield* HorizonProvider;
			const flat = yield* eph.at(loc, t);
			const polygon = yield* horizon.polygonAt(loc);
			const sunFn = sunPositionFromClient((time) => Effect.runSync(eph.positionAt(loc, time)));
			const refined = refineEventSet(flat.events as FlatEventSet, sunFn, polygon);
			return { location: loc, at: t, flat, polygon, refined } satisfies PinEphemerisReadout;
		}).pipe(Effect.provide(Layer.mergeAll(EphemerisClientLive, horizonLayer))),
	);
