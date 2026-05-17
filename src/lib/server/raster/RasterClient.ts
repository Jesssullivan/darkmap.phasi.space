import { Config, Context, Data, Effect, Layer } from 'effect';

export interface RasterQuery {
	readonly layer: string;
	readonly qt: string;
	readonly qd: string;
}

export interface RasterResponse {
	readonly contentType: string;
	readonly body: Uint8Array;
}

export class RasterError extends Data.TaggedError('RasterError')<{
	readonly status: number;
	readonly upstream: string;
	readonly cause?: unknown;
}> {}

export class RasterClient extends Context.Tag('@darkmap/RasterClient')<
	RasterClient,
	{
		readonly query: (q: RasterQuery) => Effect.Effect<RasterResponse, RasterError>;
	}
>() {}

const UPSTREAM = 'https://www.lightpollutionmap.info/QueryRaster/';

export const RasterClientLive = Layer.effect(
	RasterClient,
	Effect.gen(function* () {
		const apiKey = yield* Config.string('QUERY_RASTER_KEY');
		return {
			query: ({ layer, qt, qd }) =>
				Effect.gen(function* () {
					const url = new URL(UPSTREAM);
					url.searchParams.set('qk', apiKey);
					url.searchParams.set('ql', layer);
					url.searchParams.set('qt', qt);
					url.searchParams.set('qd', qd);
					const res = yield* Effect.tryPromise({
						try: () => fetch(url),
						catch: (cause) => new RasterError({ status: 0, upstream: url.toString(), cause }),
					});
					if (!res.ok) {
						return yield* Effect.fail(new RasterError({ status: res.status, upstream: url.toString() }));
					}
					const buffer = yield* Effect.tryPromise({
						try: () => res.arrayBuffer(),
						catch: (cause) => new RasterError({ status: res.status, upstream: url.toString(), cause }),
					});
					return {
						contentType: res.headers.get('content-type') ?? 'application/octet-stream',
						body: new Uint8Array(buffer),
					};
				}),
		};
	}),
);

/**
 * Test/preview layer. Substitutes `query` with a caller-supplied stub so unit
 * tests can exercise the SvelteKit endpoint without hitting upstream.
 */
export const makeRasterClientStub = (
	query: (q: RasterQuery) => Effect.Effect<RasterResponse, RasterError>,
): Layer.Layer<RasterClient> => Layer.succeed(RasterClient, { query });
