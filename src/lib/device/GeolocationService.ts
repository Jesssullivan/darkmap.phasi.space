import { Context, Data, Effect, Layer, type Scope } from 'effect';

export interface DevicePosition {
	readonly lat: number;
	readonly lon: number;
	readonly accuracyM: number;
	readonly altitudeM?: number | null;
	readonly altitudeAccuracyM?: number | null;
	readonly headingDeg?: number | null;
	readonly speedMps?: number | null;
	readonly timestampMs: number;
	readonly freshness: 'live' | 'stale';
}

export type DevicePositionUpdate =
	| { readonly kind: 'position'; readonly position: DevicePosition }
	| { readonly kind: 'error'; readonly error: GeolocationError };

export interface GeolocationWatch {
	readonly stop: () => void;
}

export class GeolocationError extends Data.TaggedError('GeolocationError')<{
	readonly reason: 'unsupported' | 'denied' | 'unavailable' | 'timeout' | 'failed';
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class GeolocationService extends Context.Service<
	GeolocationService,
	{
		readonly current: (options?: PositionOptions) => Effect.Effect<DevicePosition, GeolocationError>;
		readonly watch: (
			onUpdate: (update: DevicePositionUpdate) => void,
			options?: PositionOptions,
		) => Effect.Effect<GeolocationWatch, GeolocationError>;
	}
>()('@darkmap/GeolocationService') {}

/** Own a GPS watch for the caller's Effect scope, including interruption. */
export const watchGeolocationScoped = (
	onUpdate: (update: DevicePositionUpdate) => void,
	options?: PositionOptions,
): Effect.Effect<GeolocationWatch, GeolocationError, GeolocationService | Scope.Scope> =>
	Effect.acquireRelease(
		Effect.flatMap(GeolocationService, (service) => service.watch(onUpdate, options)),
		(watch) => Effect.sync(() => watch.stop()),
	);

interface NavigatorWithOptionalGeolocation {
	readonly geolocation?: Geolocation;
}

export const DEFAULT_STALE_AFTER_MS = 2 * 60_000;

export const classifyPositionFreshness = (
	timestampMs: number,
	nowMs: number,
	staleAfterMs = DEFAULT_STALE_AFTER_MS,
): DevicePosition['freshness'] => (nowMs - timestampMs > staleAfterMs ? 'stale' : 'live');

export const normalizePosition = (
	position: GeolocationPosition,
	nowMs = Date.now(),
	staleAfterMs = DEFAULT_STALE_AFTER_MS,
): DevicePosition => ({
	lat: position.coords.latitude,
	lon: position.coords.longitude,
	accuracyM: position.coords.accuracy,
	altitudeM: position.coords.altitude,
	altitudeAccuracyM: position.coords.altitudeAccuracy,
	headingDeg: position.coords.heading,
	speedMps: position.coords.speed,
	timestampMs: position.timestamp,
	freshness: classifyPositionFreshness(position.timestamp, nowMs, staleAfterMs),
});

export const geolocationErrorFromPositionError = (err: GeolocationPositionError): GeolocationError => {
	switch (err.code) {
		case 1:
			return new GeolocationError({
				reason: 'denied',
				message: err.message || 'location permission denied',
				cause: err,
			});
		case 2:
			return new GeolocationError({
				reason: 'unavailable',
				message: err.message || 'location unavailable',
				cause: err,
			});
		case 3:
			return new GeolocationError({
				reason: 'timeout',
				message: err.message || 'location request timed out',
				cause: err,
			});
		default:
			return new GeolocationError({ reason: 'failed', message: err.message || 'location request failed', cause: err });
	}
};

export const makeGeolocationServiceLive = (
	navigatorLike: NavigatorWithOptionalGeolocation,
): Layer.Layer<GeolocationService> =>
	Layer.succeed(GeolocationService, {
		current: (options) =>
			Effect.callback<DevicePosition, GeolocationError>((resume) => {
				const geolocation = navigatorLike.geolocation;
				if (!geolocation) {
					resume(Effect.fail(new GeolocationError({ reason: 'unsupported', message: 'geolocation is not available' })));
					return;
				}
				geolocation.getCurrentPosition(
					(position) => resume(Effect.succeed(normalizePosition(position))),
					(err) => resume(Effect.fail(geolocationErrorFromPositionError(err))),
					options,
				);
			}),
		watch: (onUpdate, options) =>
			Effect.gen(function* () {
				const geolocation = navigatorLike.geolocation;
				if (!geolocation) {
					return yield* Effect.fail(
						new GeolocationError({ reason: 'unsupported', message: 'geolocation is not available' }),
					);
				}
				let active = true;
				const watchId = yield* Effect.try({
					try: () =>
						geolocation.watchPosition(
							(position) => {
								if (active) onUpdate({ kind: 'position', position: normalizePosition(position) });
							},
							(err) => {
								if (active) onUpdate({ kind: 'error', error: geolocationErrorFromPositionError(err) });
							},
							options,
						),
					catch: (cause) => {
						active = false;
						return new GeolocationError({ reason: 'failed', message: 'location watch could not start', cause });
					},
				});
				return {
					stop: () => {
						if (!active) return;
						// Clear the delivery gate before clearWatch: already queued callbacks
						// must not revive a stopped follow session or its replacement.
						active = false;
						geolocation.clearWatch(watchId);
					},
				};
			}),
	});
