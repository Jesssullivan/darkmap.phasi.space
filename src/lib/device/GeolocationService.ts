import { Context, Data, Effect, Layer } from 'effect';

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

export class GeolocationService extends Context.Tag('@darkmap/GeolocationService')<
	GeolocationService,
	{
		readonly current: (options?: PositionOptions) => Effect.Effect<DevicePosition, GeolocationError>;
		readonly watch: (
			onUpdate: (update: DevicePositionUpdate) => void,
			options?: PositionOptions,
		) => Effect.Effect<GeolocationWatch, GeolocationError>;
	}
>() {}

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
			Effect.async<DevicePosition, GeolocationError>((resume) => {
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
				const watchId = geolocation.watchPosition(
					(position) => onUpdate({ kind: 'position', position: normalizePosition(position) }),
					(err) => onUpdate({ kind: 'error', error: geolocationErrorFromPositionError(err) }),
					options,
				);
				return { stop: () => geolocation.clearWatch(watchId) };
			}),
	});
