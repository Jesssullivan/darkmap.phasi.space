import { error, type RequestHandler } from '@sveltejs/kit';
import { Cause, Effect, Exit, Layer, Option } from 'effect';
import { LAYERS } from '$lib/layers';
import { sanitizeHeaders } from '$lib/server/raster/AdStripper';
import { RasterCache, RasterCacheLive } from '$lib/server/raster/Cache';
import {
	RasterClient,
	RasterClientLive,
	RasterError,
	type RasterResponse,
	type RasterTileRequest,
} from '$lib/server/raster/RasterClient';
import { parseTileCoord } from '$lib/server/raster/TileMath';

const RasterLayer = Layer.merge(RasterClientLive, RasterCacheLive);

const fetchOrCache = (req: RasterTileRequest): Effect.Effect<RasterResponse, RasterError, RasterClient | RasterCache> =>
	Effect.gen(function* () {
		const cache = yield* RasterCache;
		const cached = yield* cache.get(req);
		if (Option.isSome(cached)) return cached.value;
		const client = yield* RasterClient;
		const fresh = yield* client.getTile(req);
		yield* cache.set(req, fresh);
		return fresh;
	});

const lookupUpstreamLayer = (friendlyId: string): string | undefined =>
	LAYERS.find((l) => l.id === friendlyId)?.upstreamLayer;

export const GET: RequestHandler = async ({ url }) => {
	const layer = url.searchParams.get('layer');
	const z = url.searchParams.get('z');
	const x = url.searchParams.get('x');
	const y = url.searchParams.get('y');
	if (!layer || !z || !x || !y) {
		error(400, 'missing required params: layer, z, x, y');
	}

	const upstreamLayer = lookupUpstreamLayer(layer);
	if (!upstreamLayer) {
		error(404, `unknown layer: ${layer}`);
	}

	let tile;
	try {
		tile = parseTileCoord(z, x, y);
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'invalid tile coord');
	}

	const program = fetchOrCache({ upstreamLayer, tile }).pipe(Effect.provide(RasterLayer));
	const exit = await Effect.runPromiseExit(program);

	if (Exit.isFailure(exit)) {
		const failure = Cause.failureOption(exit.cause);
		if (Option.isSome(failure) && failure.value instanceof RasterError) {
			const status = failure.value.status;
			error(status >= 400 && status < 600 ? status : 502, 'upstream raster error');
		}
		error(500, Cause.pretty(exit.cause));
	}

	const response = exit.value;
	const headers = sanitizeHeaders(new Headers({ 'content-type': response.contentType }));
	headers.set('cache-control', 'public, max-age=3600, s-maxage=86400');
	return new Response(response.body as BodyInit, { headers });
};
