import { Context, Data, Effect, Layer } from 'effect';

export interface DeviceOrientationLike {
	readonly alpha: number | null;
	readonly absolute?: boolean;
	readonly webkitCompassHeading?: number;
}

export interface OrientationReading {
	readonly headingDeg: number;
	readonly source: 'webkit-compass' | 'absolute-alpha';
}

export type OrientationCapability = 'unsupported' | 'needs-permission' | 'granted';

export interface OrientationWatch {
	readonly stop: () => void;
}

export class OrientationError extends Data.TaggedError('OrientationError')<{
	readonly reason: 'unsupported' | 'denied' | 'failed';
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class OrientationService extends Context.Tag('@darkmap/OrientationService')<
	OrientationService,
	{
		readonly requestPermission: () => Effect.Effect<OrientationCapability, OrientationError>;
		readonly watch: (
			onReading: (reading: OrientationReading) => void,
		) => Effect.Effect<OrientationWatch, OrientationError>;
	}
>() {}

export const normalizeHeadingDeg = (deg: number): number => ((deg % 360) + 360) % 360;

export const orientationHeadingFromEvent = (event: DeviceOrientationLike): OrientationReading | null => {
	if (Number.isFinite(event.webkitCompassHeading)) {
		return { headingDeg: normalizeHeadingDeg(event.webkitCompassHeading as number), source: 'webkit-compass' };
	}
	if (event.absolute && Number.isFinite(event.alpha)) {
		return { headingDeg: normalizeHeadingDeg(360 - (event.alpha as number)), source: 'absolute-alpha' };
	}
	return null;
};

interface OrientationWindow {
	readonly DeviceOrientationEvent?: {
		readonly requestPermission?: () => Promise<'granted' | 'denied'>;
	};
	readonly addEventListener: (type: 'deviceorientation', listener: (event: DeviceOrientationEvent) => void) => void;
	readonly removeEventListener: (type: 'deviceorientation', listener: (event: DeviceOrientationEvent) => void) => void;
}

export const orientationCapabilityFor = (
	win: Pick<OrientationWindow, 'DeviceOrientationEvent'>,
): OrientationCapability => {
	if (!win.DeviceOrientationEvent) return 'unsupported';
	return typeof win.DeviceOrientationEvent.requestPermission === 'function' ? 'needs-permission' : 'granted';
};

export const makeOrientationServiceLive = (win: OrientationWindow): Layer.Layer<OrientationService> =>
	Layer.succeed(OrientationService, {
		requestPermission: () => {
			const capability = orientationCapabilityFor(win);
			if (capability === 'unsupported') {
				return Effect.fail(
					new OrientationError({ reason: 'unsupported', message: 'device orientation is not available' }),
				);
			}
			const requestPermission = win.DeviceOrientationEvent?.requestPermission;
			if (!requestPermission) return Effect.succeed('granted' as const);
			return Effect.tryPromise({
				try: async () => {
					const result = await requestPermission();
					if (result !== 'granted') {
						throw new OrientationError({ reason: 'denied', message: 'device orientation permission denied' });
					}
					return 'granted' as const;
				},
				catch: (cause) =>
					cause instanceof OrientationError
						? cause
						: new OrientationError({ reason: 'failed', message: 'device orientation permission failed', cause }),
			});
		},
		watch: (onReading) =>
			Effect.gen(function* () {
				if (orientationCapabilityFor(win) === 'unsupported') {
					return yield* Effect.fail(
						new OrientationError({ reason: 'unsupported', message: 'device orientation is not available' }),
					);
				}
				const listener = (event: DeviceOrientationEvent): void => {
					const reading = orientationHeadingFromEvent(event as DeviceOrientationLike);
					if (reading) onReading(reading);
				};
				win.addEventListener('deviceorientation', listener);
				return { stop: () => win.removeEventListener('deviceorientation', listener) };
			}),
	});
