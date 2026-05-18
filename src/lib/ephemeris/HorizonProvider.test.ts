import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import type { LatLon } from './EphemerisClient';
import {
	angularElevationDeg,
	chainElevationLookups,
	ElevationLookup,
	HorizonError,
	HorizonProvider,
	HorizonProviderLive,
	horizonAtAzimuth,
	makeElevationLookupStub,
	type HorizonPolygon,
} from './HorizonProvider';
import { decodeTerrariumElevation, destinationPoint, lonLatToTilePixel } from './terrarium';

const horizonWith = (elev: (loc: LatLon) => number) =>
	HorizonProviderLive.pipe(Layer.provide(makeElevationLookupStub(elev)));

const polygonOf = (
	loc: LatLon,
	elev: (loc: LatLon) => number,
	opts?: { rays?: number; distancesMeters?: readonly number[]; eyeHeightMeters?: number },
): HorizonPolygon =>
	Effect.runSync(
		Effect.gen(function* () {
			const h = yield* HorizonProvider;
			return yield* h.polygonAt(loc, opts);
		}).pipe(Effect.provide(horizonWith(elev))),
	);

describe('decodeTerrariumElevation', () => {
	it('decodes sea level encoded as (128, 0, 0)', () => {
		expect(decodeTerrariumElevation(128, 0, 0)).toBe(0);
	});

	it('decodes 1 m above sea level as (128, 1, 0)', () => {
		expect(decodeTerrariumElevation(128, 1, 0)).toBe(1);
	});

	it('decodes the max negative offset (-32768 m)', () => {
		expect(decodeTerrariumElevation(0, 0, 0)).toBe(-32768);
	});

	it('decodes 1000 m as (131, 232, 0) — sanity for a real-world value', () => {
		// 32768 + 1000 = 33768 = 131 * 256 + 232 + 0
		expect(decodeTerrariumElevation(131, 232, 0)).toBeCloseTo(1000, 6);
	});

	it('handles sub-meter fractions through the B channel', () => {
		// 0.5 m above sea level = 32768.5 = 128 * 256 + 0 + 128 / 256
		expect(decodeTerrariumElevation(128, 0, 128)).toBeCloseTo(0.5, 6);
	});
});

describe('lonLatToTilePixel', () => {
	it('places (0°, 0°) at the center of the world at z=0', () => {
		const r = lonLatToTilePixel(0, 0, 0);
		expect(r).toMatchObject({ z: 0, x: 0, y: 0 });
		expect(r.px).toBe(128);
		expect(r.py).toBe(128);
	});

	it('puts NYC (40.7, -74.0) into tile (4, 6) at z=4', () => {
		const r = lonLatToTilePixel(40.7128, -74.006, 4);
		expect(r.z).toBe(4);
		expect(r.x).toBe(4);
		expect(r.y).toBe(6);
	});
});

describe('destinationPoint', () => {
	it('1 km north of (0, 0) bumps latitude by ~0.009°', () => {
		const r = destinationPoint(0, 0, 0, 1000);
		expect(r.lat).toBeCloseTo(0.00899, 4);
		expect(r.lon).toBeCloseTo(0, 6);
	});

	it('1 km east of (0, 0) bumps longitude by ~0.009° at the equator', () => {
		const r = destinationPoint(0, 0, 90, 1000);
		expect(r.lat).toBeCloseTo(0, 6);
		expect(r.lon).toBeCloseTo(0.00899, 4);
	});

	it('wraps longitude across the antimeridian', () => {
		// 100 km east of (0, 179.99) should land just past -180.
		const r = destinationPoint(0, 179.99, 90, 100_000);
		expect(r.lon).toBeLessThan(-179);
		expect(r.lon).toBeGreaterThan(-180);
	});
});

describe('angularElevationDeg', () => {
	it('flat horizon at eye height reads ~0°', () => {
		// At 1 km, target at same elevation as eye. Curvature drop subtracts
		// a tiny amount → result is slightly negative (a few hundredths of
		// a degree).
		const alt = angularElevationDeg(100, 100, 1000);
		expect(alt).toBeLessThan(0);
		expect(alt).toBeGreaterThan(-0.1);
	});

	it('mountain 1000 m taller than observer at 5 km reads ~11°', () => {
		const alt = angularElevationDeg(0, 1000, 5000);
		expect(alt).toBeGreaterThan(10);
		expect(alt).toBeLessThan(12);
	});

	it('valley 100 m below observer at 1 km reads ~-5.7°', () => {
		const alt = angularElevationDeg(0, -100, 1000);
		expect(alt).toBeLessThan(-5);
		expect(alt).toBeGreaterThan(-6.5);
	});

	it('curvature drop accumulates with distance — same-elev target at 10 km dips below 0', () => {
		const alt = angularElevationDeg(0, 0, 10_000);
		expect(alt).toBeLessThan(-0.03);
		expect(alt).toBeGreaterThan(-0.1);
	});
});

describe('HorizonProvider — synchronous ray-cast against stub elevation', () => {
	it('flat terrain yields a polygon at ~0° in every direction (modulo curvature)', () => {
		const poly = polygonOf({ lat: 0, lon: 0 }, () => 0, { rays: 8 });
		expect(poly).toHaveLength(8);
		for (const p of poly) {
			expect(p.altitudeDeg).toBeLessThan(0);
			expect(p.altitudeDeg).toBeGreaterThan(-1);
		}
	});

	it('an east-side wall makes east azimuths positive and west azimuths flat', () => {
		// Stub: elevation = 100 m if lon > observer.lon, else 0.
		const poly = polygonOf({ lat: 0, lon: 0 }, (l) => (l.lon > 0 ? 100 : 0), {
			rays: 8,
			distancesMeters: [500, 1000, 2000],
		});
		const byAz = new Map(poly.map((p) => [p.azimuthDeg, p.altitudeDeg]));
		// Due east (90°) — strong positive
		expect(byAz.get(90)!).toBeGreaterThan(3);
		// Due west (270°) — at flat-ground curvature
		expect(byAz.get(270)!).toBeLessThan(0);
		expect(byAz.get(270)!).toBeGreaterThan(-1);
	});

	it('respects ray count', () => {
		const poly = polygonOf({ lat: 0, lon: 0 }, () => 0, { rays: 12 });
		expect(poly).toHaveLength(12);
		expect(poly[0].azimuthDeg).toBe(0);
		expect(poly[6].azimuthDeg).toBe(180);
	});

	it('honors eye height — taller observer sees over short obstacles', () => {
		// Observer at (0,0) where ground is 0 m; everywhere else ground is
		// 10 m (a ring of low hills). Short observer looks up at the hills;
		// tall observer is above them.
		const obstacle = (l: LatLon) => (l.lat === 0 && l.lon === 0 ? 0 : 10);
		const tallStub = polygonOf({ lat: 0, lon: 0 }, obstacle, {
			rays: 4,
			distancesMeters: [250],
			eyeHeightMeters: 100,
		});
		const shortStub = polygonOf({ lat: 0, lon: 0 }, obstacle, {
			rays: 4,
			distancesMeters: [250],
			eyeHeightMeters: 1.7,
		});
		// Tall observer (eye at 100 m, hill at 10 m) — looks ~-20° down
		expect(tallStub[0].altitudeDeg).toBeLessThan(-15);
		// Short observer (eye at 1.7 m, hill at 10 m) — looks ~+1.9° up
		expect(shortStub[0].altitudeDeg).toBeGreaterThan(1);
	});
});

describe('horizonAtAzimuth', () => {
	it('interpolates linearly between two adjacent samples', () => {
		const poly: HorizonPolygon = [
			{ azimuthDeg: 0, altitudeDeg: 0 },
			{ azimuthDeg: 90, altitudeDeg: 10 },
			{ azimuthDeg: 180, altitudeDeg: 0 },
			{ azimuthDeg: 270, altitudeDeg: -5 },
		];
		expect(horizonAtAzimuth(poly, 45)).toBeCloseTo(5, 6);
		expect(horizonAtAzimuth(poly, 90)).toBe(10);
		expect(horizonAtAzimuth(poly, 135)).toBeCloseTo(5, 6);
	});

	it('handles wrap-around past 360°', () => {
		const poly: HorizonPolygon = [
			{ azimuthDeg: 0, altitudeDeg: 0 },
			{ azimuthDeg: 270, altitudeDeg: 8 },
		];
		// 315° is half-way between 270° and the wrapped 0° (=360°).
		expect(horizonAtAzimuth(poly, 315)).toBeCloseTo(4, 6);
	});

	it('returns 0 for an empty polygon', () => {
		expect(horizonAtAzimuth([], 42)).toBe(0);
	});
});

describe('HorizonProvider — polygon cache', () => {
	const opts = { rays: 4, distancesMeters: [500, 1000] };

	/**
	 * Run two `polygonAt` calls inside a single Effect program so the
	 * cache (which lives in the Layer's construction closure) survives
	 * between them. Two `Effect.runSync` calls would each rebuild the
	 * runtime and lose the cache.
	 */
	const runPair = (
		layer: Layer.Layer<HorizonProvider>,
		a: { loc: LatLon; opts: typeof opts },
		b: { loc: LatLon; opts: typeof opts },
	) =>
		Effect.runSync(
			Effect.gen(function* () {
				const h = yield* HorizonProvider;
				yield* h.polygonAt(a.loc, a.opts);
				return yield* h.polygonAt(b.loc, b.opts);
			}).pipe(Effect.provide(layer)),
		);

	it('skips elevation calls on a cache hit (same loc + opts)', () => {
		let calls = 0;
		const layer = horizonWith(() => {
			calls += 1;
			return 0;
		});
		// First call populates the cache; second should be a hit.
		runPair(layer, { loc: { lat: 10, lon: 20 }, opts }, { loc: { lat: 10, lon: 20 }, opts });
		// rays=4 + 2 distances + 1 ground-elev call = 9 lookups for one pass.
		expect(calls).toBe(9);
	});

	it('treats sub-0.001° location changes as cache hits', () => {
		let calls = 0;
		const layer = horizonWith(() => {
			calls += 1;
			return 0;
		});
		runPair(layer, { loc: { lat: 42.12345, lon: -76.5 }, opts }, { loc: { lat: 42.12349, lon: -76.5004 }, opts });
		expect(calls).toBe(9);
	});

	it('treats different opts (rays count) as cache misses', () => {
		let calls = 0;
		const layer = horizonWith(() => {
			calls += 1;
			return 0;
		});
		runPair(
			layer,
			{ loc: { lat: 10, lon: 20 }, opts: { rays: 4, distancesMeters: [500] } },
			{ loc: { lat: 10, lon: 20 }, opts: { rays: 8, distancesMeters: [500] } },
		);
		// 5 (rays=4, 1 distance + ground) + 9 (rays=8, 1 distance + ground) = 14 lookups
		expect(calls).toBe(14);
	});
});

describe('chainElevationLookups', () => {
	const getMeters = (layer: Layer.Layer<ElevationLookup>) =>
		Effect.runSync(
			Effect.gen(function* () {
				const e = yield* ElevationLookup;
				return yield* e.metersAt({ lat: 0, lon: 0 });
			}).pipe(Effect.provide(layer)),
		);

	const failingLayer = (reason: string): Layer.Layer<ElevationLookup> =>
		Layer.succeed(ElevationLookup, {
			metersAt: () => Effect.fail(new HorizonError({ reason })),
		});

	it('returns the primary value when it succeeds', () => {
		const chained = chainElevationLookups(
			makeElevationLookupStub(() => 100),
			makeElevationLookupStub(() => 999),
		);
		expect(getMeters(chained)).toBe(100);
	});

	it('falls through to the secondary when the primary errors', () => {
		const chained = chainElevationLookups(
			failingLayer('simulated outage'),
			makeElevationLookupStub(() => 7),
		);
		expect(getMeters(chained)).toBe(7);
	});

	it('propagates the secondary error when both fail', () => {
		const chained = chainElevationLookups(failingLayer('primary down'), failingLayer('secondary down'));
		const exit = Effect.runSyncExit(
			Effect.gen(function* () {
				const e = yield* ElevationLookup;
				return yield* e.metersAt({ lat: 0, lon: 0 });
			}).pipe(Effect.provide(chained)),
		);
		expect(exit._tag).toBe('Failure');
	});
});

describe('HorizonProvider — polygonNearAzimuth (dense local fan)', () => {
	const nearOpts = { rays: 5, halfWidthDeg: 2, distancesMeters: [500] };
	const fanOf = (elev: (l: LatLon) => number, az: number) =>
		Effect.runSync(
			Effect.gen(function* () {
				const h = yield* HorizonProvider;
				return yield* h.polygonNearAzimuth({ lat: 0, lon: 0 }, az, nearOpts);
			}).pipe(Effect.provide(horizonWith(elev))),
		);

	it('emits the requested number of rays', () => {
		const poly = fanOf(() => 0, 90);
		expect(poly).toHaveLength(5);
	});

	it('centers the fan on the requested azimuth, spanning ±halfWidth', () => {
		const poly = fanOf(() => 0, 90);
		const azs = poly.map((s) => s.azimuthDeg);
		expect(azs[0]).toBeCloseTo(88, 5);
		expect(azs[2]).toBeCloseTo(90, 5);
		expect(azs[4]).toBeCloseTo(92, 5);
	});

	it('canonicalizes azimuths to [0, 360) when fan crosses the 0° boundary', () => {
		const poly = fanOf(() => 0, 0);
		for (const s of poly) {
			expect(s.azimuthDeg).toBeGreaterThanOrEqual(0);
			expect(s.azimuthDeg).toBeLessThan(360);
		}
	});

	it('reflects directional terrain — east wall raises altitudes at azimuth 90°', () => {
		const wall = (l: LatLon) => (l.lon > 0 ? 100 : 0);
		const east = fanOf(wall, 90);
		const west = fanOf(wall, 270);
		expect(east[2].altitudeDeg).toBeGreaterThan(5);
		expect(west[2].altitudeDeg).toBeLessThan(0);
	});

	it('honors a 1-ray request (degenerate fan = single sample at azimuth - halfWidth)', () => {
		const poly = Effect.runSync(
			Effect.gen(function* () {
				const h = yield* HorizonProvider;
				return yield* h.polygonNearAzimuth({ lat: 0, lon: 0 }, 90, {
					rays: 1,
					halfWidthDeg: 2,
					distancesMeters: [500],
				});
			}).pipe(Effect.provide(horizonWith(() => 0))),
		);
		expect(poly).toHaveLength(1);
		expect(poly[0].azimuthDeg).toBeCloseTo(88, 5);
	});
});
