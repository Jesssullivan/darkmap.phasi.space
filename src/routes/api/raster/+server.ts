import { error, type RequestHandler } from '@sveltejs/kit';
import { Cause, Effect, Exit, Layer, Option } from 'effect';
import { sanitizeHeaders } from '$lib/server/raster/AdStripper';
import { RasterCache, RasterCacheLive } from '$lib/server/raster/Cache';
import {
	RasterClient,
	RasterClientLive,
	RasterError,
	type RasterQuery,
	type RasterResponse,
} from '$lib/server/raster/RasterClient';

const RasterLayer = Layer.merge(RasterClientLive, RasterCacheLive);

const fetchOrCache = (query: RasterQuery): Effect.Effect<RasterResponse, RasterError, RasterClient | RasterCache> =>
	Effect.gen(function* () {
		const cache = yield* RasterCache;
		const cached = yield* cache.get(query);
		if (Option.isSome(cached)) return cached.value;
		const client = yield* RasterClient;
		const fresh = yield* client.query(query);
		yield* cache.set(query, fresh);
		return fresh;
	});

export const GET: RequestHandler = async ({ url }) => {
	const layer = url.searchParams.get('layer');
	const qt = url.searchParams.get('qt');
	const qd = url.searchParams.get('qd');
	if (!layer || !qt || !qd) {
		error(400, 'missing required params: layer, qt, qd');
	}

	const program = fetchOrCache({ layer, qt, qd }).pipe(Effect.provide(RasterLayer));
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
