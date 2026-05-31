import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	classifyPositionFreshness,
	GeolocationService,
	geolocationErrorFromPositionError,
	makeGeolocationServiceLive,
	normalizePosition,
	type DevicePositionUpdate,
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
});
