import { Context, Data, Effect, Layer } from 'effect';
import {
	capabilityFor,
	defaultTimeForCapability,
	expandAtmosphericUrl,
	isAtmosphericLayer,
	isImmutableTime,
	type AtmosphericCapability,
} from '$lib/atmospheric-capabilities';
import type { RasterLayerDef } from '$lib/layers';
import { clampTileToMaxNativeZoom, type TileCoord } from '$lib/server/raster/TileMath';

/**
 * AtmosphericTileService — owns the GIBS WMTS fetch lifecycle:
 *
 *   1. Look up the per-layer capability (max zoom, date cadence, lag).
 *   2. Clamp the requested tile to native zoom.
 *   3. Pick a default time if the caller didn't supply one.
 *   4. Fetch the upstream URL.
 *   5. Classify the response:
 *        - 200 with non-empty body → `ok`
 *        - 204 or empty body (< 200 bytes) → transparent `no-data` tile
 *        - 404 → `no-data` (the WMTS legitimately doesn't have this tile)
 *        - Other non-2xx → `AtmosphericTileError`
 *   6. Emit cache + debug headers so the route handler can shape the
 *      Response without re-deriving any of it.
 *
 * Extracted from the inline `fetchAtmosphericTile` in `/api/raster/+server.ts`
 * (#199) so the capability + classification logic is testable and reusable
 * by future RT-grade tile sources.
 */

export type AtmosphericTileOutcome =
	| {
			readonly tag: 'ok';
			readonly status: 200;
			readonly body: ReadableStream<Uint8Array> | null;
			readonly contentType: string;
			readonly cacheControl: string;
			readonly debugHeaders: Readonly<Record<string, string>>;
	  }
	| {
			readonly tag: 'no-data';
			readonly status: 200;
			readonly body: Uint8Array;
			readonly contentType: string;
			readonly cacheControl: string;
			readonly debugHeaders: Readonly<Record<string, string>>;
	  };

export class AtmosphericTileError extends Data.TaggedError('AtmosphericTileError')<{
	readonly reason: 'no-capability' | 'no-template' | 'fetch-failed' | 'upstream-error' | 'invalid-time';
	readonly status?: number;
	readonly cause?: unknown;
}> {}

export interface AtmosphericTileRequest {
	readonly layerDef: RasterLayerDef;
	readonly tile: TileCoord;
	/** Optional ISO date or the literal `default` keyword. Else derived from capability. */
	readonly time: string | undefined;
}

export class AtmosphericTileService extends Context.Tag('@darkmap/AtmosphericTileService')<
	AtmosphericTileService,
	{
		readonly fetchTile: (req: AtmosphericTileRequest) => Effect.Effect<AtmosphericTileOutcome, AtmosphericTileError>;
	}
>() {}

export interface AtmosphericTileFetcher {
	readonly fetch: (url: string) => Promise<Response>;
}

const EMPTY_THRESHOLD_BYTES = 200; // GIBS empty-PNG tiles are <100 bytes; pad.
const NO_DATA_CACHE = 'public, max-age=600, s-maxage=3600';
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const FRESH_CACHE = 'public, max-age=3600, s-maxage=86400';
const DAY_MS = 24 * 3600 * 1000;
const TRANSPARENT_PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
	0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49,
	0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xff, 0x1f, 0x00, 0x03, 0x03, 0x02, 0x00, 0xef, 0xbf, 0xa7, 0xdb, 0x00,
	0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

type AtmosphericTileStatus = 'ok' | 'ok-fallback' | 'no-data';

const debugHeadersFor = (
	layerDef: RasterLayerDef,
	requestTile: TileCoord,
	nativeTile: TileCoord,
	requestedTime: string,
	sourceTime: string,
	outcome: 'ok' | 'no-data',
	status: AtmosphericTileStatus,
	upstreamStatus?: number,
): Record<string, string> => {
	const headers: Record<string, string> = {
		'x-darkmap-atmospheric-layer': layerDef.id,
		'x-darkmap-atmospheric-request-tile': `${requestTile.z}/${requestTile.x}/${requestTile.y}`,
		'x-darkmap-atmospheric-native-tile': `${nativeTile.z}/${nativeTile.x}/${nativeTile.y}`,
		'x-darkmap-atmospheric-time': requestedTime,
		'x-darkmap-atmospheric-source-time': sourceTime,
		'x-darkmap-atmospheric-outcome': outcome,
		'x-darkmap-atmospheric-status': status,
	};
	if (upstreamStatus !== undefined) {
		headers['x-darkmap-atmospheric-upstream-status'] = String(upstreamStatus);
	}
	return headers;
};

const isEmptyImageResponse = async (
	upstream: Response,
): Promise<{ readonly empty: boolean; readonly body: ReadableStream<Uint8Array> | null }> => {
	if (upstream.status === 204) return { empty: true, body: null };
	const contentLengthHeader = upstream.headers.get('content-length');
	if (contentLengthHeader !== null) {
		const contentLength = Number(contentLengthHeader);
		if (Number.isFinite(contentLength) && contentLength < EMPTY_THRESHOLD_BYTES) {
			// Drain so the upstream connection can close cleanly.
			await upstream.arrayBuffer();
			return { empty: true, body: null };
		}
	}
	return { empty: false, body: upstream.body };
};

interface AtmosphericTileAttempt {
	readonly url: string;
	readonly nativeTile: TileCoord;
	readonly requestedTime: string;
	readonly sourceTime: string;
}

interface AtmosphericNoDataObservation {
	readonly sourceTime: string;
	readonly upstreamStatus: number;
}

const computeAttempts = (
	layerDef: RasterLayerDef,
	cap: AtmosphericCapability,
	requestTile: TileCoord,
	timeInput: string | undefined,
	now: Date,
): readonly AtmosphericTileAttempt[] | undefined => {
	if (!isAtmosphericLayer(layerDef)) return undefined;
	const nativeTile = clampTileToMaxNativeZoom(requestTile, cap.maxNativeZoom);
	const explicitTime = timeInput && timeInput.length > 0 ? timeInput : undefined;
	const requestedTime = explicitTime ?? defaultTimeForCapability(cap, now);
	// GIBS daily science products publish with an ~18-24h lag, so "today" (and at
	// the UTC boundary, yesterday) returns an empty no-data tile. The live map
	// ALWAYS sends an explicit time=today for the "now" view, so gating the
	// walk-back on `!explicitTime` meant the default view never fell back and
	// every atmospheric overlay rendered blank. Walk back a couple of days for any
	// *recent* date — explicit or not — so "now" shows the latest available
	// imagery; static-cadence layers and the 'default' sentinel keep one attempt,
	// and older historical scrubs (already published) are requested as-is.
	const wantsFallback =
		cap.dateCadence !== 'static' &&
		requestedTime !== 'default' &&
		(explicitTime === undefined || isRecentDate(requestedTime, now));
	const sourceTimes = wantsFallback
		? [requestedTime, addDays(requestedTime, -1), addDays(requestedTime, -2)]
		: [requestedTime];
	return sourceTimes.map((sourceTime) => ({
		url: expandAtmosphericUrl(layerDef.upstreamUrlTemplate, nativeTile.z, nativeTile.x, nativeTile.y, sourceTime),
		nativeTile,
		requestedTime,
		sourceTime,
	}));
};

const addDays = (date: string, days: number): string => {
	const parsed = Date.parse(`${date}T00:00:00.000Z`);
	if (!Number.isFinite(parsed)) return date;
	return new Date(parsed + days * DAY_MS).toISOString().slice(0, 10);
};

/**
 * Is `date` (YYYY-MM-DD) within the GIBS near-real-time publication-lag window?
 * Recent dates may not be published yet, so they warrant a walk-back; older
 * dates are settled and should be requested as-is. Spans 3 days back through 1
 * day forward to tolerate UTC/local skew at the date boundary.
 */
const isRecentDate = (date: string, now: Date): boolean => {
	const parsed = Date.parse(`${date}T00:00:00.000Z`);
	if (!Number.isFinite(parsed)) return false;
	const ageMs = now.getTime() - parsed;
	return ageMs <= 3 * DAY_MS && ageMs >= -1 * DAY_MS;
};

export const makeAtmosphericTileServiceLive = (
	fetcher: AtmosphericTileFetcher,
	clock: () => Date = () => new Date(),
): Layer.Layer<AtmosphericTileService> =>
	Layer.succeed(AtmosphericTileService, {
		fetchTile: (req) =>
			Effect.gen(function* () {
				const cap = capabilityFor(req.layerDef.id);
				if (!cap) {
					return yield* Effect.fail(new AtmosphericTileError({ reason: 'no-capability' }));
				}
				const attempts = computeAttempts(req.layerDef, cap, req.tile, req.time, clock());
				if (!attempts || attempts.length === 0) {
					return yield* Effect.fail(new AtmosphericTileError({ reason: 'no-template' }));
				}

				let lastNoData: AtmosphericNoDataObservation | undefined;
				for (const attempt of attempts) {
					const { url, nativeTile, requestedTime, sourceTime } = attempt;
					// Effect.tryPromise already routes a rejected fetch into the typed
					// failure channel (AtmosphericTileError 'fetch-failed'); yield*
					// short-circuits via the runtime, so a surrounding try/catch can
					// never fire — it was dead and is dropped.
					const upstream = yield* Effect.tryPromise({
						try: () => fetcher.fetch(url),
						catch: (cause) => new AtmosphericTileError({ reason: 'fetch-failed', cause }),
					});

					// 404 from GIBS is a legitimate "no tile for this (z,x,y,time)"
					// — try older default dates before surfacing no-data. Other
					// non-2xx statuses remain structural upstream failures.
					if (upstream.status === 404) {
						lastNoData = { sourceTime, upstreamStatus: upstream.status };
						continue;
					}
					if (!upstream.ok && upstream.status !== 204) {
						return yield* Effect.fail(new AtmosphericTileError({ reason: 'upstream-error', status: upstream.status }));
					}

					const { empty, body } = yield* Effect.promise(() => isEmptyImageResponse(upstream));
					if (empty) {
						lastNoData = { sourceTime, upstreamStatus: upstream.status };
						continue;
					}

					const contentType = upstream.headers.get('content-type') ?? 'image/jpeg';
					const cacheControl = isImmutableTime(sourceTime, clock()) ? IMMUTABLE_CACHE : FRESH_CACHE;
					return {
						tag: 'ok',
						status: 200,
						body,
						contentType,
						cacheControl,
						debugHeaders: debugHeadersFor(
							req.layerDef,
							req.tile,
							nativeTile,
							requestedTime,
							sourceTime,
							'ok',
							sourceTime === requestedTime ? 'ok' : 'ok-fallback',
						),
					} as const;
				}

				const lastAttempt = attempts[attempts.length - 1];
				return {
					tag: 'no-data',
					status: 200,
					body: TRANSPARENT_PNG,
					contentType: 'image/png',
					cacheControl: NO_DATA_CACHE,
					debugHeaders: debugHeadersFor(
						req.layerDef,
						req.tile,
						lastAttempt.nativeTile,
						lastAttempt.requestedTime,
						lastNoData?.sourceTime ?? lastAttempt.sourceTime,
						'no-data',
						'no-data',
						lastNoData?.upstreamStatus,
					),
				} as const;
			}),
	});

/** Live Layer bound to the global `fetch`. SSR-safe via Layer.suspend. */
export const AtmosphericTileServiceLive: Layer.Layer<AtmosphericTileService> = Layer.suspend(() =>
	makeAtmosphericTileServiceLive({ fetch: (url) => fetch(url) }),
);
