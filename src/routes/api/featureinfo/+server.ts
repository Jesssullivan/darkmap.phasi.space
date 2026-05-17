import { error, type RequestHandler } from '@sveltejs/kit';
import { Cause, Effect, Exit, Option } from 'effect';
import { LAYERS } from '$lib/layers';
import { sanitizeHeaders } from '$lib/server/raster/AdStripper';
import { PointQueryClient, PointQueryClientLive, PointQueryError } from '$lib/server/raster/PointQuery';

export const GET: RequestHandler = async ({ url }) => {
	const layerId = url.searchParams.get('layer');
	const latStr = url.searchParams.get('lat');
	const lonStr = url.searchParams.get('lon');
	if (!layerId || !latStr || !lonStr) {
		error(400, 'missing required params: layer, lat, lon');
	}
	const lat = Number.parseFloat(latStr);
	const lon = Number.parseFloat(lonStr);
	if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
		error(400, `invalid lat/lon: ${latStr}, ${lonStr}`);
	}

	const upstreamLayer = LAYERS.find((l) => l.id === layerId)?.upstreamLayer;
	if (!upstreamLayer) {
		error(404, `unknown layer: ${layerId}`);
	}

	const program = Effect.gen(function* () {
		const client = yield* PointQueryClient;
		return yield* client.readAt({ viirsLayer: upstreamLayer, lat, lon });
	}).pipe(Effect.provide(PointQueryClientLive));

	const exit = await Effect.runPromiseExit(program);

	if (Exit.isFailure(exit)) {
		const failure = Cause.failureOption(exit.cause);
		if (Option.isSome(failure) && failure.value instanceof PointQueryError) {
			const status = failure.value.status;
			error(status >= 400 && status < 600 ? status : 502, 'upstream point-query error');
		}
		error(500, Cause.pretty(exit.cause));
	}

	const headers = sanitizeHeaders(new Headers({ 'content-type': 'application/json' }));
	headers.set('cache-control', 'public, max-age=300, s-maxage=3600');
	return new Response(JSON.stringify(exit.value), { headers });
};
