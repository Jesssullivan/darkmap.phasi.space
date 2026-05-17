import { Context, Data, Effect, Layer } from 'effect';
import { bboxParam, tileBBox3857, type TileCoord } from './TileMath';

/**
 * Upstream layer identifier (e.g., `PostGIS:VIIRS_2019`,
 * `lighttrends:viirs_npp_202112`, `PostGIS:WA_2015`). The browser-facing
 * `layers.ts` manifest maps friendly ids onto these.
 */
export interface RasterTileRequest {
	readonly upstreamLayer: string;
	readonly tile: TileCoord;
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
		readonly getTile: (req: RasterTileRequest) => Effect.Effect<RasterResponse, RasterError>;
	}
>() {}

/**
 * GeoServer WMS GetMap endpoint. Public (no auth, no cookies).
 *
 * Live discovery 2026-05-17: GetCapabilities returns 50 PostGIS:* layers
 * (annual VIIRS + Falchi WA_2015) + 223 lighttrends:* layers (monthly
 * VIIRS composites). No rate-limit headers. EPSG:3857 supported via
 * WMS 1.1.1 (`srs=EPSG:3857`); WMS 1.3.0 with `crs=` returns 400 for
 * tile-sized bboxes — stay on 1.1.1.
 */
const UPSTREAM_WMS = 'https://www2.lightpollutionmap.info/geoserver/gwc/service/wms';

export const RasterClientLive = Layer.succeed(
	RasterClient,
	RasterClient.of({
		getTile: ({ upstreamLayer, tile }) =>
			Effect.gen(function* () {
				const url = new URL(UPSTREAM_WMS);
				url.searchParams.set('service', 'WMS');
				url.searchParams.set('version', '1.1.1');
				url.searchParams.set('request', 'GetMap');
				url.searchParams.set('layers', upstreamLayer);
				url.searchParams.set('styles', '');
				url.searchParams.set('format', 'image/png');
				url.searchParams.set('transparent', 'true');
				url.searchParams.set('srs', 'EPSG:3857');
				url.searchParams.set('width', '256');
				url.searchParams.set('height', '256');
				url.searchParams.set('bbox', bboxParam(tileBBox3857(tile)));

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
					contentType: res.headers.get('content-type') ?? 'image/png',
					body: new Uint8Array(buffer),
				};
			}),
	}),
);

/**
 * Test/preview layer. Substitutes `getTile` with a caller-supplied stub
 * so unit tests can exercise the SvelteKit endpoint without hitting
 * upstream.
 */
export const makeRasterClientStub = (
	getTile: (req: RasterTileRequest) => Effect.Effect<RasterResponse, RasterError>,
): Layer.Layer<RasterClient> => Layer.succeed(RasterClient, { getTile });
