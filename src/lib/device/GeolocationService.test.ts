import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	classifyPositionFreshness,
	GeolocationService,
	geolocationErrorFromPositionError,
	makeGeolocationServiceLive,
	normalizePosition,
	type DevicePositionUpdate,
	type GeolocationWatch,
	watchGeolocationScoped,
} from './GeolocationService';

const position = (timestamp: number): GeolocationPosition =>
	({
		timestamp,
		coords: {
			latitude: 42.443,
			longitude: -76.501,
			accuracy: 12,
			altitude: 301,
			altitudeAccuracy: 8,
			heading: 270,
			speed: 1.5,
		},
	}) as GeolocationPosition;

describe('GeolocationService', () => {
	it('normalizes browser positions into the local field model', () => {
		expect(normalizePosition(position(1_000), 2_000)).toEqual({
			lat: 42.443,
			lon: -76.501,
			accuracyM: 12,
			altitudeM: 301,
			altitudeAccuracyM: 8,
			headingDeg: 270,
			speedMps: 1.5,
			timestampMs: 1_000,
			freshness: 'live',
		});
	});

	it('classifies stale positions against a bounded age', () => {
		expect(classifyPositionFreshness(0, 120_001)).toBe('stale');
		expect(classifyPositionFreshness(0, 120_000)).toBe('live');
	});

	it('maps permission denial into a structured error', () => {
		const err = geolocationErrorFromPositionError({ code: 1, message: 'denied' } as GeolocationPositionError);
		expect(err.reason).toBe('denied');
	});

	it('gets the current position through an Effect layer', async () => {
		const geolocation = {
			getCurrentPosition: (ok: PositionCallback) => ok(position(Date.now())),
			watchPosition: () => 1,
			clearWatch: () => undefined,
		} as unknown as Geolocation;
		const eff = Effect.flatMap(GeolocationService, (svc) => svc.current()).pipe(
			Effect.provide(makeGeolocationServiceLive({ geolocation })),
		);
		await expect(Effect.runPromise(eff)).resolves.toMatchObject({ lat: 42.443, lon: -76.501 });
	});

	it('reports unsupported browsers without throwing', async () => {
		const eff = Effect.flatMap(GeolocationService, (svc) => svc.current()).pipe(
			Effect.provide(makeGeolocationServiceLive({ geolocation: undefined })),
		);
		const exit = await Effect.runPromiseExit(eff);
		expect(JSON.stringify(exit)).toContain('"reason":"unsupported"');
	});

	it('starts and stops watch-position mode', async () => {
		let cleared = 0;
		const updates: DevicePositionUpdate[] = [];
		const geolocation = {
			getCurrentPosition: () => undefined,
			watchPosition: (ok: PositionCallback) => {
				ok(position(Date.now()));
				return 42;
			},
			clearWatch: (id: number) => {
				cleared = id;
			},
		} as unknown as Geolocation;
		const eff = Effect.flatMap(GeolocationService, (svc) => svc.watch((update) => updates.push(update))).pipe(
			Effect.provide(makeGeolocationServiceLive({ geolocation })),
		);
		const watch = await Effect.runPromise(eff);
		watch.stop();
		expect(updates[0]).toMatchObject({ kind: 'position' });
		expect(cleared).toBe(42);
	});

	const makeWatchHarness = () => {
		const callbacks: Array<{ ok: PositionCallback; error: PositionErrorCallback | null }> = [];
		const cleared: number[] = [];
		const geolocation = {
			getCurrentPosition: () => undefined,
			watchPosition: (ok: PositionCallback, error: PositionErrorCallback | null) => {
				callbacks.push({ ok, error });
				return callbacks.length;
			},
			clearWatch: (id: number) => cleared.push(id),
		} as unknown as Geolocation;
		return { callbacks, cleared, layer: makeGeolocationServiceLive({ geolocation }) };
	};

	it('ignores delayed position and error callbacks after an idempotent stop', async () => {
		const { callbacks, cleared, layer } = makeWatchHarness();
		const updates: DevicePositionUpdate[] = [];
		const watch = await Effect.runPromise(
			Effect.flatMap(GeolocationService, (service) => service.watch((update) => updates.push(update))).pipe(
				Effect.provide(layer),
			),
		);
		callbacks[0].ok(position(Date.now()));
		expect(updates).toHaveLength(1);
		watch.stop();
		watch.stop();
		callbacks[0].ok(position(Date.now()));
		callbacks[0].error?.({ code: 1, message: 'late denial' } as GeolocationPositionError);
		expect(updates).toHaveLength(1);
		expect(cleared).toEqual([1]);
	});

	it('keeps an old watch from writing into a restarted session', async () => {
		const { callbacks, cleared, layer } = makeWatchHarness();
		const updates: DevicePositionUpdate[] = [];
		const acquire = Effect.flatMap(GeolocationService, (service) =>
			service.watch((update) => updates.push(update)),
		).pipe(Effect.provide(layer));
		const first = await Effect.runPromise(acquire);
		first.stop();
		const second = await Effect.runPromise(acquire);
		callbacks[0].ok(position(1));
		callbacks[0].error?.({ code: 2, message: 'old unavailable' } as GeolocationPositionError);
		callbacks[1].ok(position(Date.now()));
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({ kind: 'position', position: { freshness: 'live' } });
		second.stop();
		expect(cleared).toEqual([1, 2]);
	});

	it('can stop from inside a delivered callback without leaking subsequent updates', async () => {
		const { callbacks, cleared, layer } = makeWatchHarness();
		let delivered = 0;
		const watch: GeolocationWatch = await Effect.runPromise(
			Effect.flatMap(GeolocationService, (service) =>
				service.watch(() => {
					delivered++;
					watch.stop();
				}),
			).pipe(Effect.provide(layer)),
		);
		callbacks[0].ok(position(Date.now()));
		callbacks[0].ok(position(Date.now()));
		watch.stop();
		expect(delivered).toBe(1);
		expect(cleared).toEqual([1]);
	});

	it('closes callback delivery before invoking the browser clearWatch API', async () => {
		let latePosition: PositionCallback | undefined;
		let lateError: PositionErrorCallback | null = null;
		const updates: DevicePositionUpdate[] = [];
		const geolocation = {
			watchPosition: (ok: PositionCallback, error: PositionErrorCallback | null) => {
				latePosition = ok;
				lateError = error;
				return 1;
			},
			clearWatch: () => {
				latePosition?.(position(Date.now()));
				lateError?.({ code: 2, message: 'queued unavailable' } as GeolocationPositionError);
			},
		} as unknown as Geolocation;
		const watch = await Effect.runPromise(
			Effect.flatMap(GeolocationService, (service) => service.watch((update) => updates.push(update))).pipe(
				Effect.provide(makeGeolocationServiceLive({ geolocation })),
			),
		);
		watch.stop();
		expect(updates).toHaveLength(0);
	});

	it.each(['success', 'failure'] as const)('releases a scoped watch once on scope %s', async (outcome) => {
		const { callbacks, cleared, layer } = makeWatchHarness();
		const updates: DevicePositionUpdate[] = [];
		const exit = await Effect.runPromiseExit(
			Effect.scoped(
				Effect.gen(function* () {
					yield* watchGeolocationScoped((update) => updates.push(update));
					if (outcome === 'failure') return yield* Effect.fail('consumer failed');
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(exit._tag).toBe(outcome === 'success' ? 'Success' : 'Failure');
		callbacks[0].ok(position(Date.now()));
		callbacks[0].error?.({ code: 3, message: 'late timeout' } as GeolocationPositionError);
		expect(updates).toHaveLength(0);
		expect(cleared).toEqual([1]);
	});

	it('releases a scoped watch when its fiber is interrupted', async () => {
		const { callbacks, cleared, layer } = makeWatchHarness();
		const acquired = await Effect.runPromise(Deferred.make<void>());
		const updates: DevicePositionUpdate[] = [];
		const fiber = Effect.runFork(
			Effect.scoped(
				Effect.gen(function* () {
					yield* watchGeolocationScoped((update) => updates.push(update));
					yield* Deferred.succeed(acquired, undefined);
					return yield* Effect.never;
				}),
			).pipe(Effect.provide(layer)),
		);
		await Effect.runPromise(Deferred.await(acquired));
		await Effect.runPromise(Fiber.interrupt(fiber));
		callbacks[0].ok(position(Date.now()));
		callbacks[0].error?.({ code: 1, message: 'late denial' } as GeolocationPositionError);
		expect(updates).toHaveLength(0);
		expect(cleared).toEqual([1]);
	});

	it('does not clear twice when a scoped watch is manually stopped', async () => {
		const { cleared, layer } = makeWatchHarness();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const watch = yield* watchGeolocationScoped(() => undefined);
					watch.stop();
					watch.stop();
				}),
			).pipe(Effect.provide(layer)),
		);
		expect(cleared).toEqual([1]);
	});

	it('preserves the typed unsupported error for scoped acquisition without a GPS API', async () => {
		const exit = await Effect.runPromiseExit(
			Effect.scoped(watchGeolocationScoped(() => undefined)).pipe(Effect.provide(makeGeolocationServiceLive({}))),
		);
		expect(JSON.stringify(exit)).toContain('"reason":"unsupported"');
	});

	it('reports synchronous watch acquisition failure without delivering abandoned callbacks', async () => {
		let latePosition: PositionCallback | undefined;
		let delivered = 0;
		const geolocation = {
			watchPosition: (ok: PositionCallback) => {
				latePosition = ok;
				throw new Error('watch API failed');
			},
		} as unknown as Geolocation;
		const exit = await Effect.runPromiseExit(
			Effect.scoped(watchGeolocationScoped(() => delivered++)).pipe(
				Effect.provide(makeGeolocationServiceLive({ geolocation })),
			),
		);
		expect(JSON.stringify(exit)).toContain('"reason":"failed"');
		latePosition?.(position(Date.now()));
		expect(delivered).toBe(0);
	});
});
