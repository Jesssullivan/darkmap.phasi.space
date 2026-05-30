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
		readonly hasReading?: boolean;
		readonly parameterName?: string;
		readonly unit?: string;
	};
	readonly geometry: { readonly type: 'Point'; readonly coordinates: readonly [number, number] };
}

export interface OpenAQCollectionMeta {
	readonly bbox?: OpenAQBbox;
	readonly fetchedAt?: string;
	readonly featureCount: number;
	readonly numericCount: number;
	readonly nullCount: number;
	readonly degraded: boolean;
	readonly capped: boolean;
	readonly limit?: number;
	readonly upstreamFound?: number;
}

export interface OpenAQSensorCollection {
	readonly type: 'FeatureCollection';
	readonly features: ReadonlyArray<OpenAQSensorFeature>;
	/** True when the proxy reports `OPENAQ_API_KEY` was missing or upstream returned 401. */
	readonly degraded?: boolean;
	readonly meta: OpenAQCollectionMeta;
}

export class OpenAQError extends Data.TaggedError('OpenAQError')<{
	readonly reason: 'fetch-failed' | 'parse-failed';
	readonly status?: number;
	readonly cause?: unknown;
}> {}

export class OpenAQService extends Context.Tag('@darkmap/OpenAQService')<
	OpenAQService,
	{
		readonly getSensors: (
			bbox: OpenAQBbox,
			options?: { readonly signal?: AbortSignal },
		) => Effect.Effect<OpenAQSensorCollection, OpenAQError>;
	}
>() {}

export const openAQUrl = (bbox: OpenAQBbox): string =>
	`/api/atmospheric/openaq?bbox=${bbox.west.toFixed(4)},${bbox.south.toFixed(4)},${bbox.east.toFixed(4)},${bbox.north.toFixed(4)}`;

export interface OpenAQFetcher {
	readonly fetch: (
		url: string,
		init?: { readonly signal?: AbortSignal },
	) => Promise<{ readonly ok: boolean; readonly status: number; readonly json: () => Promise<unknown> }>;
}

export const makeOpenAQServiceLive = (fetcher: OpenAQFetcher): Layer.Layer<OpenAQService> =>
	Layer.succeed(OpenAQService, {
		getSensors: (bbox, options) =>
			Effect.gen(function* () {
				const res = yield* Effect.tryPromise({
					try: () => fetcher.fetch(openAQUrl(bbox), options?.signal ? { signal: options.signal } : undefined),
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
		const hasReading = typeof props.hasReading === 'boolean' ? props.hasReading : value !== null;
		const parameterName = typeof props.parameterName === 'string' ? props.parameterName : undefined;
		const unit = typeof props.unit === 'string' ? props.unit : undefined;
		features.push({
			type: 'Feature',
			properties: { locationName, value, locationId, hasReading, parameterName, unit },
			geometry: { type: 'Point', coordinates: [lon, lat] as const },
		});
	}
	const degraded = obj.degraded === true;
	return Effect.succeed({
		type: 'FeatureCollection',
		features,
		degraded,
		meta: parseMeta(obj.meta, features, degraded),
	});
};

export const openAQNumericReadingCount = (collection: OpenAQSensorCollection): number =>
	Number.isFinite(collection.meta.numericCount)
		? collection.meta.numericCount
		: collection.features.filter((f) => f.properties.value !== null).length;

const parseMeta = (
	raw: unknown,
	features: ReadonlyArray<OpenAQSensorFeature>,
	degraded: boolean,
): OpenAQCollectionMeta => {
	const rawObj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
	const bbox = parseBbox(rawObj?.bbox);
	const featureCount = numberOr(rawObj?.featureCount, features.length);
	const numericCount = numberOr(rawObj?.numericCount, features.filter((f) => f.properties.value !== null).length);
	const nullCount = numberOr(rawObj?.nullCount, Math.max(0, featureCount - numericCount));
	return {
		...(bbox ? { bbox } : {}),
		...(typeof rawObj?.fetchedAt === 'string' ? { fetchedAt: rawObj.fetchedAt } : {}),
		featureCount,
		numericCount,
		nullCount,
		degraded,
		capped: rawObj?.capped === true,
		...(typeof rawObj?.limit === 'number' && Number.isFinite(rawObj.limit) ? { limit: rawObj.limit } : {}),
		...(typeof rawObj?.upstreamFound === 'number' && Number.isFinite(rawObj.upstreamFound)
			? { upstreamFound: rawObj.upstreamFound }
			: {}),
	};
};

const parseBbox = (raw: unknown): OpenAQBbox | undefined => {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const obj = raw as Record<string, unknown>;
	const west = obj.west;
	const south = obj.south;
	const east = obj.east;
	const north = obj.north;
	if (
		typeof west !== 'number' ||
		typeof south !== 'number' ||
		typeof east !== 'number' ||
		typeof north !== 'number' ||
		!Number.isFinite(west) ||
		!Number.isFinite(south) ||
		!Number.isFinite(east) ||
		!Number.isFinite(north)
	) {
		return undefined;
	}
	return { west, south, east, north };
};

const numberOr = (raw: unknown, fallback: number): number =>
	typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;

export const OpenAQServiceLive: Layer.Layer<OpenAQService> = Layer.suspend(() =>
	makeOpenAQServiceLive({ fetch: (url, init) => fetch(url, init) }),
);
