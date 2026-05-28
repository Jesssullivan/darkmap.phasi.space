import { Context, Data, Effect, Layer } from 'effect';

/**
 * OpenAQService — viewport-scoped PM2.5 ground-station readings from
 * OpenAQ v3 via the `/api/atmospheric/openaq` proxy (the server holds the
 * `OPENAQ_API_KEY`; the browser never sees it).
 *
 * The proxy returns GeoJSON ready for a MapLibre GeoJSON source — each
 * feature carries `{ value: number | null, locationName: string }` so the
 * +page.svelte heatmap + circle paint can drive color from
 * `['get', 'value']` directly.
 *
 * When the API key is missing or upstream errors, the proxy returns an
 * empty FeatureCollection with a soft warning header. The Effect service
 * treats that as a successful empty result so the smog overlay degrades
 * to "nothing rendered" rather than a toast spam.
 */

export interface OpenAQBbox {
	readonly west: number;
	readonly south: number;
	readonly east: number;
	readonly north: number;
}

export interface OpenAQSensorFeature {
	readonly type: 'Feature';
	readonly properties: {
		readonly locationName: string;
		readonly value: number | null;
		readonly locationId?: number;
	};
	readonly geometry: { readonly type: 'Point'; readonly coordinates: readonly [number, number] };
}

export interface OpenAQSensorCollection {
	readonly type: 'FeatureCollection';
	readonly features: ReadonlyArray<OpenAQSensorFeature>;
	/** True when the proxy reports `OPENAQ_API_KEY` was missing or upstream returned 401. */
	readonly degraded?: boolean;
}

export class OpenAQError extends Data.TaggedError('OpenAQError')<{
	readonly reason: 'fetch-failed' | 'parse-failed';
	readonly status?: number;
	readonly cause?: unknown;
}> {}

export class OpenAQService extends Context.Tag('@darkmap/OpenAQService')<
	OpenAQService,
	{
		readonly getSensors: (bbox: OpenAQBbox) => Effect.Effect<OpenAQSensorCollection, OpenAQError>;
	}
>() {}

export const openAQUrl = (bbox: OpenAQBbox): string =>
	`/api/atmospheric/openaq?bbox=${bbox.west.toFixed(4)},${bbox.south.toFixed(4)},${bbox.east.toFixed(4)},${bbox.north.toFixed(4)}`;

export interface OpenAQFetcher {
	readonly fetch: (
		url: string,
	) => Promise<{ readonly ok: boolean; readonly status: number; readonly json: () => Promise<unknown> }>;
}

export const makeOpenAQServiceLive = (fetcher: OpenAQFetcher): Layer.Layer<OpenAQService> =>
	Layer.succeed(OpenAQService, {
		getSensors: (bbox) =>
			Effect.gen(function* () {
				const res = yield* Effect.tryPromise({
					try: () => fetcher.fetch(openAQUrl(bbox)),
					catch: (cause) => new OpenAQError({ reason: 'fetch-failed', cause }),
				});
				if (!res.ok) {
					return yield* Effect.fail(new OpenAQError({ reason: 'fetch-failed', status: res.status }));
				}
				const body = yield* Effect.tryPromise({
					try: () => res.json(),
					catch: (cause) => new OpenAQError({ reason: 'parse-failed', cause }),
				});
				return yield* parseCollection(body);
			}),
	});

const parseCollection = (body: unknown): Effect.Effect<OpenAQSensorCollection, OpenAQError> => {
	if (typeof body !== 'object' || body === null) {
		return Effect.fail(new OpenAQError({ reason: 'parse-failed' }));
	}
	const obj = body as Record<string, unknown>;
	if (obj.type !== 'FeatureCollection' || !Array.isArray(obj.features)) {
		return Effect.fail(new OpenAQError({ reason: 'parse-failed' }));
	}
	const features: OpenAQSensorFeature[] = [];
	for (const raw of obj.features) {
		if (typeof raw !== 'object' || raw === null) continue;
		const f = raw as Record<string, unknown>;
		const geom = f.geometry as { type?: string; coordinates?: unknown } | undefined;
		if (geom?.type !== 'Point' || !Array.isArray(geom.coordinates) || geom.coordinates.length !== 2) continue;
		const [lon, lat] = geom.coordinates as [unknown, unknown];
		if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
		const props = (f.properties ?? {}) as Record<string, unknown>;
		const value = typeof props.value === 'number' && Number.isFinite(props.value) ? props.value : null;
		const locationName = typeof props.locationName === 'string' ? props.locationName : 'Unknown';
		const locationId = typeof props.locationId === 'number' ? props.locationId : undefined;
		features.push({
			type: 'Feature',
			properties: { locationName, value, locationId },
			geometry: { type: 'Point', coordinates: [lon, lat] as const },
		});
	}
	return Effect.succeed({
		type: 'FeatureCollection',
		features,
		degraded: obj.degraded === true,
	});
};

export const OpenAQServiceLive: Layer.Layer<OpenAQService> = Layer.suspend(() =>
	makeOpenAQServiceLive({ fetch: (url) => fetch(url) }),
);
