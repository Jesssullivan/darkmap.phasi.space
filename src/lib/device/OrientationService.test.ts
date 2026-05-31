import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	makeOrientationServiceLive,
	orientationCapabilityFor,
	orientationHeadingFromEvent,
	OrientationService,
	type OrientationReading,
} from './OrientationService';

describe('OrientationService', () => {
	it('normalizes iOS webkit compass heading', () => {
		expect(orientationHeadingFromEvent({ alpha: null, webkitCompassHeading: 725 })).toEqual({
			headingDeg: 5,
			source: 'webkit-compass',
		});
	});

	it('normalizes absolute alpha into a compass heading', () => {
		expect(orientationHeadingFromEvent({ alpha: 90, absolute: true })).toEqual({
			headingDeg: 270,
			source: 'absolute-alpha',
		});
	});

	it('requires absolute alpha before using generic orientation events', () => {
		expect(orientationHeadingFromEvent({ alpha: 90, absolute: false })).toBeNull();
	});

	it('detects permission-gated iOS capability', () => {
		expect(
			orientationCapabilityFor({
				DeviceOrientationEvent: { requestPermission: async () => 'granted' },
			}),
		).toBe('needs-permission');
	});

	it('requests permission through an Effect layer', async () => {
		const win = {
			DeviceOrientationEvent: { requestPermission: async () => 'granted' as const },
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		};
		const eff = Effect.flatMap(OrientationService, (svc) => svc.requestPermission()).pipe(
			Effect.provide(makeOrientationServiceLive(win)),
		);
		await expect(Effect.runPromise(eff)).resolves.toBe('granted');
	});

	it('starts and stops orientation watching', async () => {
		let listener: ((event: DeviceOrientationEvent) => void) | undefined;
		let removed = false;
		const readings: OrientationReading[] = [];
		const win = {
			DeviceOrientationEvent: {},
			addEventListener: (_type: 'deviceorientation', cb: (event: DeviceOrientationEvent) => void) => {
				listener = cb;
			},
			removeEventListener: (_type: 'deviceorientation', cb: (event: DeviceOrientationEvent) => void) => {
				removed = cb === listener;
			},
		};
		const eff = Effect.flatMap(OrientationService, (svc) => svc.watch((reading) => readings.push(reading))).pipe(
			Effect.provide(makeOrientationServiceLive(win)),
		);
		const watch = await Effect.runPromise(eff);
		listener?.({ alpha: 180, absolute: true } as DeviceOrientationEvent);
		watch.stop();
		expect(readings).toEqual([{ headingDeg: 180, source: 'absolute-alpha' }]);
		expect(removed).toBe(true);
	});
});
