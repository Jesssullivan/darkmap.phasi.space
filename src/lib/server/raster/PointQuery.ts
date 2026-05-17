import { Context, Data, Effect, Layer } from 'effect';

/**
 * Two upstream layers carry different signal at a clicked point:
 *
 * - `PostGIS:VIIRS_<year>` is styled — GetFeatureInfo returns the
 *   rendered RGB color (RED_BAND, GREEN_BAND, BLUE_BAND, ALPHA_BAND).
 *   Useful for relative brightness comparison.
 * - `PostGIS:WA_2015_raw` is unstyled — GetFeatureInfo returns the
 *   raw Falchi 2015 radiance value as `GRAY_INDEX` (mcd/m²).
 *
 * This client issues both requests in parallel and returns a unified
 * `PointReadout`.
 */

export interface PointReadout {
	readonly viirs?: {
		readonly layer: string;
		readonly red: number;
		readonly green: number;
		readonly blue: number;
		readonly alpha: number;
	};
	readonly worldAtlas?: {
		/** Falchi 2015 raw radiance, mcd/m². Higher = more light pollution. */
		readonly grayIndex: number;
	};
}

export class PointQueryError extends Data.TaggedError('PointQueryError')<{
	readonly status: number;
	readonly upstream: string;
	readonly cause?: unknown;
}> {}

export class PointQueryClient extends Context.Tag('@darkmap/PointQueryClient')<
	PointQueryClient,
	{
		readonly readAt: (args: {
			readonly viirsLayer: string;
			readonly lat: number;
			readonly lon: number;
		}) => Effect.Effect<PointReadout, PointQueryError>;
	}
>() {}

const UPSTREAM_WMS = 'https://www2.lightpollutionmap.info/geoserver/gwc/service/wms';
const WA_RAW = 'PostGIS:WA_2015_raw';

/** Web Mercator (EPSG:3857) projection — same constant as TileMath. */
const HALF_EQUATOR_M = 20037508.342789244;

/** Project lon/lat to EPSG:3857 meters. */
function lonLatTo3857(lon: number, lat: number): [number, number] {
	const x = (lon / 180) * HALF_EQUATOR_M;
	const y = (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180) / 180) * HALF_EQUATOR_M;
	return [x, y];
}

/** A 1m-square bbox centered on the click — enough to read the single pixel. */
function tinyBBoxAround(lat: number, lon: number, halfSize = 1): string {
	const [x, y] = lonLatTo3857(lon, lat);
	return `${x - halfSize},${y - halfSize},${x + halfSize},${y + halfSize}`;
}

function buildUrl(params: Record<string, string>): string {
	const u = new URL(UPSTREAM_WMS);
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
	return u.toString();
}

const featureInfoBase = (layer: string, bbox: string): string =>
	buildUrl({
		service: 'WMS',
		version: '1.1.1',
		request: 'GetFeatureInfo',
		layers: layer,
		query_layers: layer,
		srs: 'EPSG:3857',
		bbox,
		width: '1',
		height: '1',
		x: '0',
		y: '0',
		info_format: 'application/json',
	});

interface UpstreamFeatureCollection {
	readonly features?: ReadonlyArray<{
		readonly properties?: Record<string, unknown>;
	}>;
}

const fetchProps = (url: string): Effect.Effect<Record<string, unknown> | undefined, PointQueryError> =>
	Effect.gen(function* () {
		const res = yield* Effect.tryPromise({
			try: () => fetch(url),
			catch: (cause) => new PointQueryError({ status: 0, upstream: url, cause }),
		});
		if (!res.ok) {
			return yield* Effect.fail(new PointQueryError({ status: res.status, upstream: url }));
		}
		const body = (yield* Effect.tryPromise({
			try: () => res.json() as Promise<UpstreamFeatureCollection>,
			catch: (cause) => new PointQueryError({ status: res.status, upstream: url, cause }),
		})) as UpstreamFeatureCollection;
		return body.features?.[0]?.properties;
	});

const asNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export const PointQueryClientLive = Layer.succeed(
	PointQueryClient,
	PointQueryClient.of({
		readAt: ({ viirsLayer, lat, lon }) =>
			Effect.gen(function* () {
				const bbox = tinyBBoxAround(lat, lon);
				const [viirsProps, waProps] = yield* Effect.all(
					[fetchProps(featureInfoBase(viirsLayer, bbox)), fetchProps(featureInfoBase(WA_RAW, bbox))],
					{ concurrency: 2 },
				);
				const out: { -readonly [K in keyof PointReadout]: PointReadout[K] } = {};
				const r = asNum(viirsProps?.RED_BAND);
				const g = asNum(viirsProps?.GREEN_BAND);
				const b = asNum(viirsProps?.BLUE_BAND);
				const a = asNum(viirsProps?.ALPHA_BAND);
				if (r !== undefined && g !== undefined && b !== undefined && a !== undefined) {
					out.viirs = { layer: viirsLayer, red: r, green: g, blue: b, alpha: a };
				}
				const gi = asNum(waProps?.GRAY_INDEX);
				if (gi !== undefined) out.worldAtlas = { grayIndex: gi };
				return out as PointReadout;
			}),
	}),
);

export const makePointQueryClientStub = (
	readAt: (args: { viirsLayer: string; lat: number; lon: number }) => Effect.Effect<PointReadout, PointQueryError>,
): Layer.Layer<PointQueryClient> => Layer.succeed(PointQueryClient, { readAt });
