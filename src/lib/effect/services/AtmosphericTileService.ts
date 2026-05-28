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
 *        - 204 or empty body (< 200 bytes) → `no-data` (degraded, cacheable)
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
			readonly status: 204;
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

const debugHeadersFor = (
	layerDef: RasterLayerDef,
	requestTile: TileCoord,
	nativeTile: TileCoord,
	effectiveTime: string,
	outcome: 'ok' | 'no-data',
): Record<string, string> => ({
	'x-darkmap-atmospheric-layer': layerDef.id,
	'x-darkmap-atmospheric-request-tile': `${requestTile.z}/${requestTile.x}/${requestTile.y}`,
	'x-darkmap-atmospheric-native-tile': `${nativeTile.z}/${nativeTile.x}/${nativeTile.y}`,
	'x-darkmap-atmospheric-time': effectiveTime,
	'x-darkmap-atmospheric-outcome': outcome,
});

const isEmptyImageResponse = async (
	upstream: Response,
): Promise<{ readonly empty: boolean; readonly body: ReadableStream<Uint8Array> | null }> => {
	if (upstream.status === 204) return { empty: true, body: null };
	const contentLength = Number(upstream.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > 0 && contentLength < EMPTY_THRESHOLD_BYTES) {
		// Drain so the upstream connection can close cleanly.
		await upstream.arrayBuffer();
		return { empty: true, body: null };
	}
	return { empty: false, body: upstream.body };
};

const computeUrl = (
	layerDef: RasterLayerDef,
	cap: AtmosphericCapability,
	requestTile: TileCoord,
	timeInput: string | undefined,
	now: Date,
): { readonly url: string; readonly nativeTile: TileCoord; readonly effectiveTime: string } | undefined => {
	if (!isAtmosphericLayer(layerDef)) return undefined;
	const nativeTile = clampTileToMaxNativeZoom(requestTile, cap.maxNativeZoom);
	const effectiveTime = timeInput ?? defaultTimeForCapability(cap, now);
	const url = expandAtmosphericUrl(
		layerDef.upstreamUrlTemplate,
		nativeTile.z,
		nativeTile.x,
		nativeTile.y,
		effectiveTime,
	);
	return { url, nativeTile, effectiveTime };
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
				const expanded = computeUrl(req.layerDef, cap, req.tile, req.time, clock());
				if (!expanded) {
					return yield* Effect.fail(new AtmosphericTileError({ reason: 'no-template' }));
				}
				const { url, nativeTile, effectiveTime } = expanded;

				let upstream: Response;
				try {
					upstream = yield* Effect.tryPromise({
						try: () => fetcher.fetch(url),
						catch: (cause) => new AtmosphericTileError({ reason: 'fetch-failed', cause }),
					});
				} catch (cause) {
					return yield* Effect.fail(new AtmosphericTileError({ reason: 'fetch-failed', cause }));
				}

				// 404 from GIBS is a legitimate "no tile for this (z,x,y,time)"
				// — surface as 204 no-data, not 502. Other non-2xx is structural.
				if (upstream.status === 404) {
					return {
						tag: 'no-data',
						status: 204,
						cacheControl: NO_DATA_CACHE,
						debugHeaders: debugHeadersFor(req.layerDef, req.tile, nativeTile, effectiveTime, 'no-data'),
					} as const;
				}
				if (!upstream.ok && upstream.status !== 204) {
					return yield* Effect.fail(new AtmosphericTileError({ reason: 'upstream-error', status: upstream.status }));
				}

				const { empty, body } = yield* Effect.promise(() => isEmptyImageResponse(upstream));
				if (empty) {
					return {
						tag: 'no-data',
						status: 204,
						cacheControl: NO_DATA_CACHE,
						debugHeaders: debugHeadersFor(req.layerDef, req.tile, nativeTile, effectiveTime, 'no-data'),
					} as const;
				}

				const contentType = upstream.headers.get('content-type') ?? 'image/jpeg';
				const cacheControl = isImmutableTime(effectiveTime, clock()) ? IMMUTABLE_CACHE : FRESH_CACHE;
				return {
					tag: 'ok',
					status: 200,
					body,
					contentType,
					cacheControl,
					debugHeaders: debugHeadersFor(req.layerDef, req.tile, nativeTile, effectiveTime, 'ok'),
				} as const;
			}),
	});

/** Live Layer bound to the global `fetch`. SSR-safe via Layer.suspend. */
export const AtmosphericTileServiceLive: Layer.Layer<AtmosphericTileService> = Layer.suspend(() =>
	makeAtmosphericTileServiceLive({ fetch: (url) => fetch(url) }),
);
