import { Context, Data, Effect, Layer } from 'effect';

/**
 * OpenAQHistoryService — recent hourly history for a single criteria pollutant
 * at a station/point, via the `/api/atmospheric/openaq-history` proxy (V6-2 /
 * TIN-1754). The server holds `OPENAQ_API_KEY`; the browser never sees it.
 *
 * The proxy resolves a sensor (by locationId or lat/lon), pulls
 * `/v3/sensors/{id}/hours`, and returns an HONEST series: real samples only,
 * gaps absent (never interpolated), a mean over real samples, and a half-over-
 * half trend. When the key is missing / upstream degrades / no station measures
 * the pollutant, the proxy returns `{ series: null, degraded: true }`; this
 * service treats that as a successful "no series" so the readout's sparkline
 * just stays absent rather than spamming an error.
 */

export const HISTORY_POLLUTANT_NAMES = ['pm25', 'pm10', 'no2', 'o3', 'so2', 'co'] as const;
export type HistoryPollutantName = (typeof HISTORY_POLLUTANT_NAMES)[number];
const POLLUTANT_SET = new Set<string>(HISTORY_POLLUTANT_NAMES);

export type TrendDirection = 'rising' | 'falling' | 'flat';

export interface HourlyPoint {
	readonly at: string;
	readonly value: number;
}

export interface HistorySeries {
	readonly parameter: HistoryPollutantName;
	readonly units: string | null;
	readonly points: ReadonlyArray<HourlyPoint>;
	readonly sampleCount: number;
	readonly mean: number | null;
	readonly min: number | null;
	readonly max: number | null;
	readonly windowFrom: string;
	readonly windowTo: string;
	readonly latestAt: string | null;
	readonly latestValue: number | null;
	readonly trend: TrendDirection;
	readonly trendDelta: number | null;
	readonly stale: boolean;
}

export interface OpenAQHistoryResult {
	/** Null when no station/sensor/data resolved (degraded or empty). */
	readonly series: HistorySeries | null;
	readonly locationId?: number;
	readonly sensorId?: number;
	/** True when the proxy reported the key missing / upstream degraded. */
	readonly degraded: boolean;
}

export interface OpenAQHistoryRequest {
	/** Resolve by station id… */
	readonly locationId?: number;
	/** …or by point (the proxy finds the nearest station). */
	readonly lat?: number;
	readonly lon?: number;
	/** Criteria pollutant; defaults to pm25 on the proxy side. */
	readonly param?: HistoryPollutantName;
	/** Window length in hours (proxy caps it). */
	readonly hours?: number;
}

export class OpenAQHistoryError extends Data.TaggedError('OpenAQHistoryError')<{
	readonly reason: 'fetch-failed' | 'parse-failed';
	readonly status?: number;
	readonly cause?: unknown;
}> {}

export class OpenAQHistoryService extends Context.Tag('@darkmap/OpenAQHistoryService')<
	OpenAQHistoryService,
	{
		readonly getHistory: (
			req: OpenAQHistoryRequest,
			options?: { readonly signal?: AbortSignal },
		) => Effect.Effect<OpenAQHistoryResult, OpenAQHistoryError>;
	}
>() {}

/** Bake the `/api/atmospheric/openaq-history` query string for a request. */
export const openAQHistoryUrl = (req: OpenAQHistoryRequest): string => {
	const params = new URLSearchParams();
	if (typeof req.locationId === 'number') {
		params.set('locationId', String(req.locationId));
	} else if (typeof req.lat === 'number' && typeof req.lon === 'number') {
		params.set('lat', req.lat.toFixed(4));
		params.set('lon', req.lon.toFixed(4));
	}
	if (req.param) params.set('param', req.param);
	if (typeof req.hours === 'number') params.set('hours', String(req.hours));
	return `/api/atmospheric/openaq-history?${params}`;
};

export interface OpenAQHistoryFetcher {
	readonly fetch: (
		url: string,
		init?: { readonly signal?: AbortSignal },
	) => Promise<{ readonly ok: boolean; readonly status: number; readonly json: () => Promise<unknown> }>;
}

export const makeOpenAQHistoryServiceLive = (fetcher: OpenAQHistoryFetcher): Layer.Layer<OpenAQHistoryService> =>
	Layer.succeed(OpenAQHistoryService, {
		getHistory: (req, options) =>
			Effect.gen(function* () {
				const res = yield* Effect.tryPromise({
					try: () => fetcher.fetch(openAQHistoryUrl(req), options?.signal ? { signal: options.signal } : undefined),
					catch: (cause) => new OpenAQHistoryError({ reason: 'fetch-failed', cause }),
				});
				if (!res.ok) {
					return yield* Effect.fail(new OpenAQHistoryError({ reason: 'fetch-failed', status: res.status }));
				}
				const body = yield* Effect.tryPromise({
					try: () => res.json(),
					catch: (cause) => new OpenAQHistoryError({ reason: 'parse-failed', cause }),
				});
				return yield* parseResult(body);
			}),
	});

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): number | null => (isFiniteNum(v) ? v : null);

const parseSeries = (raw: unknown): HistorySeries | null => {
	if (typeof raw !== 'object' || raw === null) return null;
	const s = raw as Record<string, unknown>;
	const param =
		typeof s.parameter === 'string' && POLLUTANT_SET.has(s.parameter) ? (s.parameter as HistoryPollutantName) : null;
	if (param === null) return null;
	const trend: TrendDirection = s.trend === 'rising' || s.trend === 'falling' || s.trend === 'flat' ? s.trend : 'flat';
	const points: HourlyPoint[] = [];
	if (Array.isArray(s.points)) {
		for (const raw of s.points) {
			if (typeof raw !== 'object' || raw === null) continue;
			const p = raw as Record<string, unknown>;
			if (typeof p.at !== 'string' || !isFiniteNum(p.value)) continue;
			points.push({ at: p.at, value: p.value });
		}
	}
	return {
		parameter: param,
		units: typeof s.units === 'string' ? s.units : null,
		points,
		sampleCount: typeof s.sampleCount === 'number' ? s.sampleCount : points.length,
		mean: numOrNull(s.mean),
		min: numOrNull(s.min),
		max: numOrNull(s.max),
		windowFrom: typeof s.windowFrom === 'string' ? s.windowFrom : '',
		windowTo: typeof s.windowTo === 'string' ? s.windowTo : '',
		latestAt: typeof s.latestAt === 'string' ? s.latestAt : null,
		latestValue: numOrNull(s.latestValue),
		trend,
		trendDelta: numOrNull(s.trendDelta),
		stale: s.stale === true,
	};
};

export const parseResult = (body: unknown): Effect.Effect<OpenAQHistoryResult, OpenAQHistoryError> => {
	if (typeof body !== 'object' || body === null) {
		return Effect.fail(new OpenAQHistoryError({ reason: 'parse-failed' }));
	}
	const obj = body as Record<string, unknown>;
	const series = parseSeries(obj.series);
	return Effect.succeed({
		series,
		locationId: typeof obj.locationId === 'number' ? obj.locationId : undefined,
		sensorId: typeof obj.sensorId === 'number' ? obj.sensorId : undefined,
		degraded: obj.degraded === true,
	});
};

/** Live Layer bound to the global `fetch`. SSR-safe via Layer.suspend. */
export const OpenAQHistoryServiceLive: Layer.Layer<OpenAQHistoryService> = Layer.suspend(() =>
	makeOpenAQHistoryServiceLive({ fetch: (url, init) => fetch(url, init) }),
);
