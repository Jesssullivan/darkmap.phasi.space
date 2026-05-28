import { Context, Data, Effect, Layer } from 'effect';

/**
 * AtmosphericPointService — point-source atmospheric readings for a
 * (lat, lon, time) tuple, sourced from Open-Meteo `/v1/forecast` through the
 * `/api/atmospheric/point` proxy. The proxy handles the upstream HTTP, picks
 * the nearest forecast hour to the requested time, and shapes the response
 * down to the fields PointReadout consumes.
 *
 * Wrapped as an Effect service so the caller side (page.svelte `queryAt`)
 * gets structured error reporting + the same tagged-failure ergonomics
 * RouteImport / OfflineCache already use.
 */

export interface AtmosphericPointRequest {
	readonly lat: number;
	readonly lon: number;
	readonly time: Date;
}

export interface AtmosphericPointReading {
	/** Precipitable water column, mm. */
	readonly pwv: number;
	/** Relative humidity at 2 m, percent (0..100). */
	readonly rh: number;
	/** Low-cloud cover, percent (0..100). */
	readonly cloudLow: number;
	/** Mid-cloud cover, percent (0..100). */
	readonly cloudMid: number;
	/** High-cloud cover, percent (0..100). */
	readonly cloudHigh: number;
	/** Visibility, meters. */
	readonly visibility: number;
	/** ISO-8601 timestamp of the matched forecast hour. */
	readonly matchedTime: string;
}

export class AtmosphericPointError extends Data.TaggedError('AtmosphericPointError')<{
	readonly reason: 'fetch-failed' | 'parse-failed' | 'no-data';
	readonly status?: number;
	readonly cause?: unknown;
}> {}

export class AtmosphericPointService extends Context.Tag('@darkmap/AtmosphericPointService')<
	AtmosphericPointService,
	{
		readonly getReading: (
			req: AtmosphericPointRequest,
		) => Effect.Effect<AtmosphericPointReading, AtmosphericPointError>;
	}
>() {}

/** Bake the `/api/atmospheric/point` query string for a request. */
export const atmosphericPointUrl = (req: AtmosphericPointRequest): string =>
	`/api/atmospheric/point?lat=${req.lat.toFixed(4)}&lon=${req.lon.toFixed(4)}&time=${encodeURIComponent(
		req.time.toISOString(),
	)}`;

export interface AtmosphericPointFetcher {
	readonly fetch: (
		url: string,
	) => Promise<{ readonly ok: boolean; readonly status: number; readonly json: () => Promise<unknown> }>;
}

/** Test/preview helper: build the Service from an injectable fetcher. */
export const makeAtmosphericPointServiceLive = (
	fetcher: AtmosphericPointFetcher,
): Layer.Layer<AtmosphericPointService> =>
	Layer.succeed(AtmosphericPointService, {
		getReading: (req) =>
			Effect.gen(function* () {
				const url = atmosphericPointUrl(req);
				const res = yield* Effect.tryPromise({
					try: () => fetcher.fetch(url),
					catch: (cause) => new AtmosphericPointError({ reason: 'fetch-failed', cause }),
				});
				if (!res.ok) {
					return yield* Effect.fail(new AtmosphericPointError({ reason: 'fetch-failed', status: res.status }));
				}
				const body = yield* Effect.tryPromise({
					try: () => res.json(),
					catch: (cause) => new AtmosphericPointError({ reason: 'parse-failed', cause }),
				});
				return yield* parseReading(body);
			}),
	});

const parseReading = (body: unknown): Effect.Effect<AtmosphericPointReading, AtmosphericPointError> => {
	if (typeof body !== 'object' || body === null) {
		return Effect.fail(new AtmosphericPointError({ reason: 'no-data' }));
	}
	const obj = body as Record<string, unknown>;
	const fields: (keyof AtmosphericPointReading)[] = ['pwv', 'rh', 'cloudLow', 'cloudMid', 'cloudHigh', 'visibility'];
	for (const f of fields) {
		if (typeof obj[f] !== 'number' || !Number.isFinite(obj[f])) {
			return Effect.fail(new AtmosphericPointError({ reason: 'parse-failed' }));
		}
	}
	if (typeof obj.matchedTime !== 'string') {
		return Effect.fail(new AtmosphericPointError({ reason: 'parse-failed' }));
	}
	return Effect.succeed({
		pwv: obj.pwv as number,
		rh: obj.rh as number,
		cloudLow: obj.cloudLow as number,
		cloudMid: obj.cloudMid as number,
		cloudHigh: obj.cloudHigh as number,
		visibility: obj.visibility as number,
		matchedTime: obj.matchedTime,
	});
};

/**
 * Live Layer bound to the global `fetch`. SSR-safe: the fetcher closure
 * captures the global `fetch` lazily inside `Layer.suspend`, matching the
 * pattern OfflineCacheServiceBrowserLive uses.
 */
export const AtmosphericPointServiceLive: Layer.Layer<AtmosphericPointService> = Layer.suspend(() =>
	makeAtmosphericPointServiceLive({
		fetch: (url) => fetch(url),
	}),
);
