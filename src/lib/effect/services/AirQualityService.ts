import { Context, Data, Effect, Layer } from 'effect';

/**
 * AirQualityService — point-source pollen + air-quality readings for a
 * (lat, lon, time) tuple, sourced from Open-Meteo's Air-Quality API (CAMS)
 * through the `/api/atmospheric/airquality` proxy (V3-5).
 *
 * Mirrors AtmosphericPointService. Honesty contract: every pollen species and
 * constituent is `number | null`; a `null` means CAMS reported no value (out of
 * season / unsupported region) and must render as "none reported", never zero.
 */

export interface AirQualityPointRequest {
	readonly lat: number;
	readonly lon: number;
	readonly time: Date;
}

/** Pollen grain counts, grains/m³. Null = no model value (out of season / region). */
export interface PollenReading {
	readonly alder: number | null;
	readonly birch: number | null;
	readonly grass: number | null;
	readonly mugwort: number | null;
	readonly olive: number | null;
	readonly ragweed: number | null;
}

export interface AirQualityPointReading {
	/** ISO-8601 timestamp of the matched hour. */
	readonly matchedTime: string;
	readonly pollen: PollenReading;
	/** Surface PM2.5, µg/m³. */
	readonly pm25: number | null;
	/** Surface PM10, µg/m³. */
	readonly pm10: number | null;
	/** Column aerosol optical depth at 550 nm (CAMS), dimensionless. */
	readonly aod550: number | null;
	/** Surface dust concentration, µg/m³. */
	readonly dust: number | null;
	/** Surface ozone, µg/m³ (NOT total-column Dobson — do not feed the O₃ LUT axis directly). */
	readonly ozone: number | null;
}

export const POLLEN_SPECIES: ReadonlyArray<keyof PollenReading> = [
	'alder',
	'birch',
	'grass',
	'mugwort',
	'olive',
	'ragweed',
];

export class AirQualityError extends Data.TaggedError('AirQualityError')<{
	readonly reason: 'fetch-failed' | 'parse-failed' | 'no-data';
	readonly status?: number;
	readonly cause?: unknown;
}> {}

export class AirQualityService extends Context.Tag('@darkmap/AirQualityService')<
	AirQualityService,
	{
		readonly getReading: (
			req: AirQualityPointRequest,
			options?: { readonly signal?: AbortSignal },
		) => Effect.Effect<AirQualityPointReading, AirQualityError>;
	}
>() {}

/** Bake the `/api/atmospheric/airquality` query string for a request. */
export const airQualityPointUrl = (req: AirQualityPointRequest): string =>
	`/api/atmospheric/airquality?lat=${req.lat.toFixed(4)}&lon=${req.lon.toFixed(4)}&time=${encodeURIComponent(
		req.time.toISOString(),
	)}`;

export interface AirQualityFetcher {
	readonly fetch: (
		url: string,
		init?: { readonly signal?: AbortSignal },
	) => Promise<{ readonly ok: boolean; readonly status: number; readonly json: () => Promise<unknown> }>;
}

/** Test/preview helper: build the Service from an injectable fetcher. */
export const makeAirQualityServiceLive = (fetcher: AirQualityFetcher): Layer.Layer<AirQualityService> =>
	Layer.succeed(AirQualityService, {
		getReading: (req, options) =>
			Effect.gen(function* () {
				const url = airQualityPointUrl(req);
				const res = yield* Effect.tryPromise({
					try: () => fetcher.fetch(url, options?.signal ? { signal: options.signal } : undefined),
					catch: (cause) => new AirQualityError({ reason: 'fetch-failed', cause }),
				});
				if (!res.ok) {
					return yield* Effect.fail(new AirQualityError({ reason: 'fetch-failed', status: res.status }));
				}
				const body = yield* Effect.tryPromise({
					try: () => res.json(),
					catch: (cause) => new AirQualityError({ reason: 'parse-failed', cause }),
				});
				return yield* parseReading(body);
			}),
	});

/** A value is accepted only if it is a finite number; everything else → null. */
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const parseReading = (body: unknown): Effect.Effect<AirQualityPointReading, AirQualityError> => {
	if (typeof body !== 'object' || body === null) {
		return Effect.fail(new AirQualityError({ reason: 'no-data' }));
	}
	const obj = body as Record<string, unknown>;
	if (typeof obj.matchedTime !== 'string') {
		return Effect.fail(new AirQualityError({ reason: 'parse-failed' }));
	}
	const p = (typeof obj.pollen === 'object' && obj.pollen !== null ? obj.pollen : {}) as Record<string, unknown>;
	return Effect.succeed({
		matchedTime: obj.matchedTime,
		pollen: {
			alder: numOrNull(p.alder),
			birch: numOrNull(p.birch),
			grass: numOrNull(p.grass),
			mugwort: numOrNull(p.mugwort),
			olive: numOrNull(p.olive),
			ragweed: numOrNull(p.ragweed),
		},
		pm25: numOrNull(obj.pm25),
		pm10: numOrNull(obj.pm10),
		aod550: numOrNull(obj.aod550),
		dust: numOrNull(obj.dust),
		ozone: numOrNull(obj.ozone),
	});
};

/**
 * Live Layer bound to the global `fetch`. SSR-safe via Layer.suspend, matching
 * AtmosphericPointServiceLive.
 */
export const AirQualityServiceLive: Layer.Layer<AirQualityService> = Layer.suspend(() =>
	makeAirQualityServiceLive({
		fetch: (url, init) => fetch(url, init),
	}),
);
