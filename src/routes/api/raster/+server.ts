import { error, type RequestHandler } from '@sveltejs/kit';
import { Cause, Effect, Exit, Layer, Option } from 'effect';
import { LAYERS, type RasterLayerDef } from '$lib/layers';
import { sanitizeHeaders } from '$lib/server/raster/AdStripper';
import { RasterCache, RasterCacheLive, rasterCacheKey } from '$lib/server/raster/Cache';
import {
	RasterClient,
	RasterClientLive,
	RasterError,
	type RasterResponse,
	type RasterTileRequest,
} from '$lib/server/raster/RasterClient';
import { clampTileToMaxNativeZoom, parseTileCoord, type TileCoord } from '$lib/server/raster/TileMath';

const RasterLayer = Layer.merge(RasterClientLive, RasterCacheLive);

type RasterCacheStatus = 'HIT' | 'MISS' | 'STALE';

interface RasterFetchResult {
	readonly cacheStatus: RasterCacheStatus;
	readonly response: RasterResponse;
}

const TRANSPARENT_PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
	0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49,
	0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xff, 0x1f, 0x00, 0x03, 0x03, 0x02, 0x00, 0xef, 0xbf, 0xa7, 0xdb, 0x00,
	0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const inFlightTiles = new Map<string, Promise<Exit.Exit<RasterFetchResult, RasterError>>>();

const fetchOrCache = (
	req: RasterTileRequest,
): Effect.Effect<RasterFetchResult, RasterError, RasterClient | RasterCache> =>
	Effect.gen(function* () {
		const cache = yield* RasterCache;
		const cached = yield* cache.get(req);
		if (Option.isSome(cached)) return { cacheStatus: 'HIT', response: cached.value };

		const client = yield* RasterClient;
		return yield* client.getTile(req).pipe(
			Effect.tap((response) => cache.set(req, response)),
			Effect.map((response) => ({ cacheStatus: 'MISS' as const, response })),
			Effect.catchAll((rasterError) =>
				cache
					.getStale(req)
					.pipe(
						Effect.flatMap((stale) =>
							Option.isSome(stale)
								? Effect.succeed({ cacheStatus: 'STALE' as const, response: stale.value })
								: Effect.fail(rasterError),
						),
					),
			),
		);
	});

const lookupLayer = (friendlyId: string): RasterLayerDef | undefined => LAYERS.find((l) => l.id === friendlyId);

const runCoalesced = (req: RasterTileRequest): Promise<Exit.Exit<RasterFetchResult, RasterError>> => {
	const key = rasterCacheKey(req);
	const pending = inFlightTiles.get(key);
	if (pending) return pending;

	const program = fetchOrCache(req).pipe(Effect.provide(RasterLayer));
	const promise = Effect.runPromiseExit(program).finally(() => {
		if (inFlightTiles.get(key) === promise) inFlightTiles.delete(key);
	});
	inFlightTiles.set(key, promise);
	return promise;
};

export const GET: RequestHandler = async ({ url }) => {
	const layer = url.searchParams.get('layer');
	const z = url.searchParams.get('z');
	const x = url.searchParams.get('x');
	const y = url.searchParams.get('y');
	const kind = url.searchParams.get('kind');
	if (!layer || !z || !x || !y) {
		error(400, 'missing required params: layer, z, x, y');
	}

	const layerDef = lookupLayer(layer);
	if (!layerDef) {
		error(404, `unknown layer: ${layer}`);
	}

	let tile: TileCoord;
	try {
		tile = parseTileCoord(z, x, y);
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'invalid tile coord');
	}

	// Atmospheric layers bypass the GeoServer RasterClient and fetch a raw WMTS
	// URL template (NASA GIBS). Service-side cache is intentionally skipped here
	// in PR-A — `Cache-Control` lets the CDN + service-worker handle it. Tiles
	// dated > 48 h ago are immutable upstream and frozen accordingly.
	if (kind === 'atmospheric' || layerDef.group === 'atmospheric') {
		if (!layerDef.upstreamUrlTemplate || layerDef.group !== 'atmospheric') {
			error(400, `layer ${layer} is not an atmospheric layer`);
		}
		return fetchAtmosphericTile(layerDef, tile, url.searchParams.get('time') ?? undefined);
	}

	if (!layerDef.upstreamLayer) {
		error(500, `layer ${layer} has no upstream binding`);
	}

	const exit = await runCoalesced({ upstreamLayer: layerDef.upstreamLayer, tile });

	if (Exit.isFailure(exit)) {
		const failure = Cause.failureOption(exit.cause);
		if (Option.isSome(failure) && failure.value instanceof RasterError) {
			const status = failure.value.status;
			error(status >= 400 && status < 600 ? status : 502, 'upstream raster error');
		}
		error(500, Cause.pretty(exit.cause));
	}

	const { cacheStatus, response } = exit.value;
	const headers = sanitizeHeaders(new Headers({ 'content-type': response.contentType }));
	headers.set('cache-control', 'public, max-age=3600, stale-if-error=86400');
	headers.set('cdn-cache-control', 'public, max-age=86400, stale-if-error=604800');
	headers.set('cloudflare-cdn-cache-control', 'public, max-age=86400, stale-if-error=604800');
	headers.set('x-darkmap-raster-cache', cacheStatus);
	return new Response(response.body as BodyInit, { headers });
};

const fetchAtmosphericTile = async (
	layerDef: RasterLayerDef,
	tile: TileCoord,
	time: string | undefined,
): Promise<Response> => {
	const candidateTimes = atmosphericTimeCandidates(time);
	const template = layerDef.upstreamUrlTemplate;
	if (!template) {
		error(500, `atmospheric layer ${layerDef.id} missing upstreamUrlTemplate`);
	}
	const nativeTile = clampTileToMaxNativeZoom(tile, layerDef.maxNativeZoom);

	let lastNoDataStatus: number | undefined;
	for (const candidateTime of candidateTimes) {
		const upstreamUrl = atmosphericUpstreamUrl(template, nativeTile, candidateTime);
		let upstream: Response;
		try {
			upstream = await fetch(upstreamUrl, { headers: { accept: 'image/*' } });
		} catch (e) {
			error(502, `atmospheric upstream fetch failed: ${e instanceof Error ? e.message : 'unknown'}`);
		}

		if (isNoDataAtmosphericResponse(upstream)) {
			lastNoDataStatus = upstream.status;
			continue;
		}

		if (!upstream.ok) {
			const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
			error(status, `atmospheric upstream returned ${upstream.status}`);
		}

		const headers = atmosphericHeaders({
			contentType: upstream.headers.get('content-type') ?? 'image/jpeg',
			nativeTile,
			requestedTime: candidateTimes[0],
			sourceTime: candidateTime,
			status: candidateTime === candidateTimes[0] ? 'ok' : 'ok-fallback',
			tile,
		});
		headers.set(
			'cache-control',
			isImmutableTime(candidateTime) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600, s-maxage=86400',
		);
		return new Response(upstream.body as BodyInit | null, { status: 200, headers });
	}

	const headers = atmosphericHeaders({
		contentType: 'image/png',
		nativeTile,
		requestedTime: candidateTimes[0],
		sourceTime: candidateTimes[candidateTimes.length - 1],
		status: 'no-data',
		tile,
	});
	headers.set('cache-control', 'public, max-age=300, s-maxage=900, stale-if-error=3600');
	if (lastNoDataStatus !== undefined) {
		headers.set('x-darkmap-atmospheric-upstream-status', String(lastNoDataStatus));
	}
	return new Response(TRANSPARENT_PNG, { status: 200, headers });
};

const atmosphericUpstreamUrl = (template: string, tile: TileCoord, time: string): string =>
	template
		.replace('{z}', String(tile.z))
		.replace('{x}', String(tile.x))
		.replace('{y}', String(tile.y))
		.replace('{TIME}', time);

const atmosphericHeaders = ({
	contentType,
	nativeTile,
	requestedTime,
	sourceTime,
	status,
	tile,
}: {
	readonly contentType: string;
	readonly nativeTile: TileCoord;
	readonly requestedTime: string;
	readonly sourceTime: string;
	readonly status: 'ok' | 'ok-fallback' | 'no-data';
	readonly tile: TileCoord;
}): Headers => {
	const headers = sanitizeHeaders(new Headers({ 'content-type': contentType }));
	headers.set('x-darkmap-atmospheric-request-tile', `${tile.z}/${tile.x}/${tile.y}`);
	headers.set('x-darkmap-atmospheric-native-tile', `${nativeTile.z}/${nativeTile.x}/${nativeTile.y}`);
	headers.set('x-darkmap-atmospheric-time', requestedTime);
	headers.set('x-darkmap-atmospheric-source-time', sourceTime);
	headers.set('x-darkmap-atmospheric-status', status);
	return headers;
};

const isNoDataAtmosphericResponse = (response: Response): boolean => {
	if (response.status === 204 || response.status === 404) return true;
	return response.headers.get('content-length') === '0';
};

const atmosphericTimeCandidates = (time: string | undefined): readonly string[] => {
	if (time) return [time];
	const todayCandidate = defaultAtmosphericTime();
	return [todayCandidate, addDays(todayCandidate, -1), addDays(todayCandidate, -2)];
};

/**
 * Default time for atmospheric tiles when the client doesn't supply one.
 * GIBS publishes near-real-time imagery at T+3h SLA, so before ~06:00 UTC
 * today's tile may still be propagating — fall back to yesterday's date
 * to avoid 404s on the first paint of the day.
 */
const defaultAtmosphericTime = (): string => {
	const now = new Date();
	const ref = now.getUTCHours() < 6 ? new Date(now.getTime() - 24 * 3600 * 1000) : now;
	return ref.toISOString().slice(0, 10);
};

const addDays = (date: string, days: number): string => {
	const parsed = Date.parse(`${date}T00:00:00.000Z`);
	if (!Number.isFinite(parsed)) return date;
	return new Date(parsed + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
};

/**
 * GIBS WMTS tiles dated more than 48 h ago are frozen upstream — once a date
 * is past the science-quality reprocessing window the raster never changes.
 * Freeze them in our CDN + browser cache forever; fresher tiles get the
 * standard 1 h fresh / 24 h CDN window.
 */
const isImmutableTime = (time: string): boolean => {
	const parsed = Date.parse(time);
	if (!Number.isFinite(parsed)) return false;
	return Date.now() - parsed > 48 * 3600 * 1000;
};
