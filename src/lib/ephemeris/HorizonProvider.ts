/**
 * HorizonProvider — computes the per-azimuth horizon altitude polygon
 * for an observer at a given location, accounting for surrounding
 * terrain.
 *
 * Phase 1 (sub 4): synchronous main-thread implementation using a
 * pluggable ElevationLookup service. Sub 7 swaps in a Web Worker +
 * tile cache for production use.
 *
 * Algorithm (heywhatsthat-style):
 *  - For each of N azimuths (default 36, every 10°):
 *      For each sample distance along the ray:
 *          look up elevation, compute angular elevation from observer
 *      Keep the max angular elevation across all samples.
 *  - Returns a HorizonPolygon = (azimuth, altitude) pairs, sorted by azimuth.
 */

import { Context, Data, Effect, Layer } from 'effect';
import type { LatLon } from './EphemerisClient';
import { type HorizonPolygon, type HorizonSample, horizonAtAzimuth } from './horizonAtAzimuth';
import { destinationPoint } from './terrarium';

// Re-exported from the pure `horizonAtAzimuth` module so existing
// consumers importing from `HorizonProvider` keep working.
export { type HorizonPolygon, type HorizonSample, horizonAtAzimuth };

export class HorizonError extends Data.TaggedError('HorizonError')<{
	readonly reason: string;
	readonly cause?: unknown;
}> {}

/**
 * Pluggable elevation lookup. Sub 4 ships a Terrarium-backed Live
 * implementation that fetches tiles via the SvelteKit `/api/elevation`
 * proxy. Stub implementations let tests use synthetic terrain.
 */
export class ElevationLookup extends Context.Tag('@darkmap/ElevationLookup')<
	ElevationLookup,
	{
		readonly metersAt: (loc: LatLon) => Effect.Effect<number, HorizonError>;
	}
>() {}

export class HorizonProvider extends Context.Tag('@darkmap/HorizonProvider')<
	HorizonProvider,
	{
		readonly polygonAt: (loc: LatLon, opts?: HorizonOptions) => Effect.Effect<HorizonPolygon, HorizonError>;
		/**
		 * Dense local-fan polygon centered on a specific azimuth — used
		 * by horizon-aware event refinement so the sun's altitude is
		 * compared against the terrain at the sun's actual bearing, not
		 * a 10°-interpolated estimate.
		 */
		readonly polygonNearAzimuth: (
			loc: LatLon,
			azimuthDeg: number,
			opts?: NearAzimuthOptions,
		) => Effect.Effect<HorizonPolygon, HorizonError>;
	}
>() {}

export interface HorizonOptions {
	/** Number of azimuth rays (default 36 = every 10°). */
	readonly rays?: number;
	/**
	 * Distance samples (meters from observer). Defaults span 250 m to 25 km
	 * with a roughly logarithmic spacing — most horizons are within ~10 km
	 * for moderate-elevation observers, but distant peaks matter.
	 */
	readonly distancesMeters?: readonly number[];
	/** Observer eye height above ground (default 1.7 m, ~human standing). */
	readonly eyeHeightMeters?: number;
}

export interface NearAzimuthOptions {
	/** Number of rays in the local fan (default 5). */
	readonly rays?: number;
	/** Half-width of the fan in degrees (default 2 — total 4° span). */
	readonly halfWidthDeg?: number;
	readonly distancesMeters?: readonly number[];
	readonly eyeHeightMeters?: number;
}

const DEFAULT_NEAR_RAYS = 5;
const DEFAULT_NEAR_HALF_WIDTH_DEG = 2;

const DEFAULT_DISTANCES = [250, 500, 1_000, 2_000, 3_500, 5_500, 8_000, 12_000, 17_000, 25_000] as const;
const DEFAULT_RAYS = 36;
const DEFAULT_EYE_M = 1.7;

/**
 * Earth-curvature drop for a target at `distance` from the observer.
 * Standard formula: drop = distance² / (2 R_earth_eff). Uses R_eff =
 * 7 / 6 * R to fold in standard atmospheric refraction (k = 0.13).
 */
const curvatureDropMeters = (distanceMeters: number): number => {
	const R_EFF = (7 / 6) * 6_371_000;
	return (distanceMeters * distanceMeters) / (2 * R_EFF);
};

/**
 * Compute angular elevation (degrees, +up) from an observer at
 * (eyeElev) to a target at (targetElev) `distanceMeters` away,
 * subtracting the earth-curvature drop for the target distance.
 */
export const angularElevationDeg = (
	eyeElevMeters: number,
	targetElevMeters: number,
	distanceMeters: number,
): number => {
	const drop = curvatureDropMeters(distanceMeters);
	const dh = targetElevMeters - drop - eyeElevMeters;
	return (Math.atan2(dh, distanceMeters) * 180) / Math.PI;
};

/**
 * Round-and-stringify a polygon cache key. Locations within ~0.001°
 * (≈110 m at the equator) share a cached polygon, which is fine since
 * Terrarium z=12 tiles already cover ~9.5 km — the difference is
 * imperceptible.
 */
const polygonCacheKey = (loc: LatLon, opts: HorizonOptions | undefined): string => {
	const r = (n: number) => n.toFixed(3);
	const rays = opts?.rays ?? DEFAULT_RAYS;
	const eye = opts?.eyeHeightMeters ?? DEFAULT_EYE_M;
	const dKey = opts?.distancesMeters ? opts.distancesMeters.join(',') : 'default';
	return `${r(loc.lat)},${r(loc.lon)}|r=${rays}|e=${eye}|d=${dKey}`;
};

export const HorizonProviderLive = Layer.effect(
	HorizonProvider,
	Effect.gen(function* () {
		const elev = yield* ElevationLookup;
		// Module-private cache. One Map per Layer instantiation, which is
		// per browser tab in practice — revisiting a location is instant.
		const cache = new Map<string, HorizonPolygon>();
		return HorizonProvider.of({
			polygonAt: (loc, opts) =>
				Effect.gen(function* () {
					const key = polygonCacheKey(loc, opts);
					const hit = cache.get(key);
					if (hit) return hit;
					const rays = opts?.rays ?? DEFAULT_RAYS;
					const distances = opts?.distancesMeters ?? DEFAULT_DISTANCES;
					const eyeAddedM = opts?.eyeHeightMeters ?? DEFAULT_EYE_M;
					const groundElev = yield* elev.metersAt(loc);
					const eyeElev = groundElev + eyeAddedM;
					const out: HorizonSample[] = [];
					for (let i = 0; i < rays; i++) {
						const azimuthDeg = (i * 360) / rays;
						let maxAlt = -90;
						for (const d of distances) {
							const target = destinationPoint(loc.lat, loc.lon, azimuthDeg, d);
							const targetElev = yield* elev.metersAt(target);
							const alt = angularElevationDeg(eyeElev, targetElev, d);
							if (alt > maxAlt) maxAlt = alt;
						}
						out.push({ azimuthDeg, altitudeDeg: maxAlt });
					}
					const polygon = out as HorizonPolygon;
					cache.set(key, polygon);
					return polygon;
				}),
			polygonNearAzimuth: (loc, azimuthDeg, opts) =>
				Effect.gen(function* () {
					const rays = opts?.rays ?? DEFAULT_NEAR_RAYS;
					const halfWidth = opts?.halfWidthDeg ?? DEFAULT_NEAR_HALF_WIDTH_DEG;
					const distances = opts?.distancesMeters ?? DEFAULT_DISTANCES;
					const eyeAddedM = opts?.eyeHeightMeters ?? DEFAULT_EYE_M;
					const groundElev = yield* elev.metersAt(loc);
					const eyeElev = groundElev + eyeAddedM;
					const out: HorizonSample[] = [];
					// `rays` azimuths spanning [azimuthDeg - halfWidth, azimuthDeg + halfWidth].
					// Result is sorted by azimuth ascending in canonical (0..360].
					const step = rays === 1 ? 0 : (2 * halfWidth) / (rays - 1);
					for (let i = 0; i < rays; i++) {
						const rawAz = azimuthDeg - halfWidth + i * step;
						const az = ((rawAz % 360) + 360) % 360;
						let maxAlt = -90;
						for (const d of distances) {
							const target = destinationPoint(loc.lat, loc.lon, az, d);
							const targetElev = yield* elev.metersAt(target);
							const alt = angularElevationDeg(eyeElev, targetElev, d);
							if (alt > maxAlt) maxAlt = alt;
						}
						out.push({ azimuthDeg: az, altitudeDeg: maxAlt });
					}
					out.sort((a, b) => a.azimuthDeg - b.azimuthDeg);
					return out as HorizonPolygon;
				}),
		});
	}),
);

/**
 * Chain multiple ElevationLookup implementations so the second is tried
 * only when the first returns a HorizonError. Use this to add a
 * Mapterhorn fallback behind TerrariumElevationLookupLive: if AWS S3
 * has a regional outage, the chain transparently switches to the
 * secondary source on a per-call basis.
 *
 * Failures from the *last* provider in the chain are propagated to
 * the caller (the chain is exhausted at that point).
 */
export const chainElevationLookups = (
	primary: Layer.Layer<ElevationLookup>,
	fallback: Layer.Layer<ElevationLookup>,
): Layer.Layer<ElevationLookup> =>
	Layer.effect(
		ElevationLookup,
		Effect.gen(function* () {
			const p = yield* Effect.provide(ElevationLookup, primary);
			const f = yield* Effect.provide(ElevationLookup, fallback);
			return {
				metersAt: (loc) => p.metersAt(loc).pipe(Effect.catchAll(() => f.metersAt(loc))),
			};
		}),
	);

/**
 * Test/preview Layer. Supplies a synthetic ElevationLookup that the
 * caller provides as a (lat, lon) → meters function — useful for
 * testing the ray-cast math without the Terrarium fetch dependency.
 */
export const makeElevationLookupStub = (fn: (loc: LatLon) => number): Layer.Layer<ElevationLookup> =>
	Layer.succeed(ElevationLookup, {
		metersAt: (loc) => Effect.succeed(fn(loc)),
	});
