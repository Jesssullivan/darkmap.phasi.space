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
 *  3. Dense local fans at the sun's azimuth at flat sunrise and flat
 *     sunset — `polygonNearAzimuth` from `HorizonProvider`, sampled at
 *     1° spacing across a 30° span. Catches sub-arcminute terrain
 *     features that the 10°-sampled global polygon smooths over.
 *  4. The horizon-aware refinement — every twilight event re-bisected
 *     against the true local horizon at the sun's actual azimuth. The
 *     bisection consults the dense fan when the probe's azimuth falls
 *     within its coverage; otherwise it falls back to the global
 *     polygon. This is the `polygonResolver` from PR #81 finally
 *     wired to a real UI consumer.
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

/** Dense fan: 9 rays across ±15° centred on a key event azimuth. */
const FAN_HALF_WIDTH_DEG = 15;
const FAN_RAYS = 9;

export interface DenseFan {
	/** Azimuth (degrees) the fan is centred on — typically the sun's azimuth at a flat event. */
	readonly centerAzimuthDeg: number;
	/** The polygon itself, sorted ascending by azimuth (canonical [0, 360)). */
	readonly polygon: HorizonPolygon;
}

export interface PinEphemerisReadout {
	readonly location: LatLon;
	readonly at: Date;
	readonly flat: EphemerisReadout;
	readonly polygon: HorizonPolygon;
	/**
	 * Dense local fans pre-computed at flat-event azimuths (sunrise +
	 * sunset by default). The refinement consults whichever fan is
	 * closest in azimuth at each bisection probe, falling back to the
	 * global polygon when no fan covers the queried azimuth.
	 */
	readonly fans: ReadonlyArray<DenseFan>;
	readonly refined: FlatEventSet;
}

/**
 * Shortest unsigned angular distance between two azimuths in degrees.
 * Returns a value in `[0, 180]`.
 */
const angularDistanceDeg = (a: number, b: number): number => {
	const diff = (((a - b) % 360) + 540) % 360;
	return Math.abs(diff - 180);
};

/**
 * Build a polygon resolver that picks whichever dense fan is closest
 * to the queried azimuth (within its coverage half-width). For
 * azimuths outside any fan's coverage, returns the global polygon.
 */
const makePolygonResolver = (
	fans: ReadonlyArray<DenseFan>,
	globalPolygon: HorizonPolygon,
): ((azimuthDeg: number) => HorizonPolygon) => {
	if (fans.length === 0) return () => globalPolygon;
	return (azDeg) => {
		let best: HorizonPolygon | null = null;
		let bestDelta = Infinity;
		for (const fan of fans) {
			const delta = angularDistanceDeg(azDeg, fan.centerAzimuthDeg);
			if (delta < bestDelta) {
				bestDelta = delta;
				best = fan.polygon;
			}
		}
		return bestDelta <= FAN_HALF_WIDTH_DEG && best ? best : globalPolygon;
	};
};

/**
 * Inner program — shared by the cached and test-seam wrappers.
 * Yields the full readout including pre-computed dense fans.
 */
const computeProgram = (loc: LatLon, t: Date) =>
	Effect.gen(function* () {
		const eph = yield* EphemerisClient;
		const horizon = yield* HorizonProvider;
		const flat = yield* eph.at(loc, t);
		const polygon = yield* horizon.polygonAt(loc);
		// Pre-compute dense fans at the sun's azimuth for flat sunrise +
		// flat sunset. Skip when the event doesn't occur (polar
		// solstice). Both fan computations share Terrarium tiles with
		// the global polygon via the elevation cache.
		const fans: DenseFan[] = [];
		const eventsForFans: Array<Date | null> = [flat.events.sunrise, flat.events.sunset];
		for (const eventTime of eventsForFans) {
			if (!eventTime) continue;
			const sunPos = yield* eph.positionAt(loc, eventTime);
			const fan = yield* horizon.polygonNearAzimuth(loc, sunPos.sun.azimuthDeg, {
				halfWidthDeg: FAN_HALF_WIDTH_DEG,
				rays: FAN_RAYS,
			});
			fans.push({ centerAzimuthDeg: sunPos.sun.azimuthDeg, polygon: fan });
		}
		const polygonResolver = makePolygonResolver(fans, polygon);
		const sunFn = sunPositionFromClient((time) => Effect.runSync(eph.positionAt(loc, time)));
		const refined = refineEventSet(flat.events as FlatEventSet, sunFn, polygon, { polygonResolver });
		return {
			location: loc,
			at: t,
			flat,
			polygon,
			fans,
			refined,
		} satisfies PinEphemerisReadout;
	});

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
		computeProgram(loc, t).pipe(
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
	Effect.runPromise(computeProgram(loc, t).pipe(Effect.provide(Layer.mergeAll(EphemerisClientLive, horizonLayer))));
