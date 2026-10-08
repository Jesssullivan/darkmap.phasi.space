import { error, type RequestHandler } from '@sveltejs/kit';
import { Cause, Effect, Exit, Layer, Option } from 'effect';
import { LAYERS, type RasterLayerDef } from '$lib/layers';
import {
	AtmosphericTileError,
	AtmosphericTileService,
	AtmosphericTileServiceLive,
	type AtmosphericTileOutcome,
} from '$lib/effect/services/AtmosphericTileService';
import { sanitizeHeaders } from '$lib/server/raster/AdStripper';
import { RasterCache, RasterCacheLive, rasterCacheKey } from '$lib/server/raster/Cache';
import {
	SELF_HOSTED_BASE_URL_ENV,
	makeSelfHostedRasterClient,
	resolveSelfHostedTileConfig,
} from '$lib/server/raster/SelfHostedTiles';
import {
	RasterClient,
	RasterClientLive,
	RasterError,
	type RasterResponse,
	type RasterTileRequest,
} from '$lib/server/raster/RasterClient';
import { parseTileCoord, type TileCoord } from '$lib/server/raster/TileMath';

type RasterCacheStatus = 'HIT' | 'MISS' | 'STALE';

interface RasterFetchResult {
	readonly cacheStatus: RasterCacheStatus;
	readonly response: RasterResponse;
}

const inFlightTiles = new Map<string, Promise<Exit.Exit<RasterFetchResult, RasterError>>>();

type RasterSource = 'self-hosted' | 'upstream-wms';

// RV1: when DARKMAP_RASTER_TILE_BASE_URL is set, VIIRS tiles come from our own
// pre-rendered store (NASA Black Marble VNP46A4) and the third-party WMS is not
// contacted. Resolved lazily so the adapter-node runtime environment is used.
let rasterRuntime:
	| { readonly layer: Layer.Layer<RasterClient | RasterCache>; readonly source: RasterSource }
	| undefined;

const getRasterRuntime = () => {
	if (!rasterRuntime) {
		const selfHosted = resolveSelfHostedTileConfig(process.env[SELF_HOSTED_BASE_URL_ENV], LAYERS);
		rasterRuntime = selfHosted
			? { layer: Layer.merge(makeSelfHostedRasterClient(selfHosted), RasterCacheLive), source: 'self-hosted' }
			: { layer: Layer.merge(RasterClientLive, RasterCacheLive), source: 'upstream-wms' };
	}
	return rasterRuntime;
};

/** Test hook: forget the resolved raster source so a new environment applies. */
export const _resetRasterRuntimeForTests = (): void => {
	rasterRuntime = undefined;
	inFlightTiles.clear();
};

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
			Effect.catch((rasterError) =>
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

	const program = fetchOrCache(req).pipe(Effect.provide(getRasterRuntime().layer));
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
		return atmosphericResponse(layerDef, tile, url.searchParams.get('time') ?? undefined);
	}

	if (!layerDef.upstreamLayer) {
		error(500, `layer ${layer} has no upstream binding`);
	}

	const exit = await runCoalesced({ upstreamLayer: layerDef.upstreamLayer, tile });

	if (Exit.isFailure(exit)) {
		const failure = Cause.findErrorOption(exit.cause);
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
	headers.set('x-darkmap-raster-source', getRasterRuntime().source);
	return new Response(response.body as BodyInit, { headers });
};

/**
 * Translate an AtmosphericTileService outcome into a SvelteKit `Response`.
 * The service handles capability + classification; we only shape headers.
 */
const atmosphericResponse = async (
	layerDef: RasterLayerDef,
	tile: TileCoord,
	time: string | undefined,
): Promise<Response> => {
	const exit = await Effect.runPromiseExit(
		Effect.gen(function* () {
			const svc = yield* AtmosphericTileService;
			return yield* svc.fetchTile({ layerDef, tile, time });
		}).pipe(Effect.provide(AtmosphericTileServiceLive)),
	);
	if (Exit.isFailure(exit)) {
		const failure = Cause.findErrorOption(exit.cause);
		if (Option.isSome(failure) && failure.value instanceof AtmosphericTileError) {
			const err = failure.value;
			if (err.reason === 'upstream-error' && err.status !== undefined) {
				const status = err.status >= 400 && err.status < 600 ? err.status : 502;
				error(status, `atmospheric upstream returned ${err.status}`);
			}
			if (err.reason === 'fetch-failed') {
				error(502, `atmospheric upstream fetch failed`);
			}
			error(500, `atmospheric tile error: ${err.reason}`);
		}
		error(500, Cause.pretty(exit.cause));
	}
	return shapeAtmosphericResponse(exit.value);
};

const shapeAtmosphericResponse = (outcome: AtmosphericTileOutcome): Response => {
	const headers = sanitizeHeaders(new Headers({ 'content-type': outcome.contentType }));
	headers.set('cache-control', outcome.cacheControl);
	for (const [k, v] of Object.entries(outcome.debugHeaders)) headers.set(k, v);
	return new Response(outcome.body as BodyInit | null, { status: outcome.status, headers });
};
