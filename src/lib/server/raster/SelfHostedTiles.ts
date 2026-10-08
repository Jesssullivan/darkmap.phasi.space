import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Effect, Layer } from 'effect';
import { RasterClient, RasterError, type RasterResponse } from './RasterClient';

/**
 * Self-hosted raster tiles (RV1, TIN-1287 / GH #103).
 *
 * Production reads pre-rendered XYZ PNG tiles that we produced offline from
 * NASA Black Marble VNP46A4 (collection 002) with
 * `scripts/raster-pilot/pyramid.py`, instead of asking the third-party
 * GeoServer for a WMS GetMap per tile. The tile store is any HTTPS origin
 * (for example a Cloudflare R2 bucket on a custom domain) or a local
 * directory (`file://`, used for local proofs and an optional mounted volume).
 *
 * Layout: `${base}/${layer.selfHostedPath}/${z}/${x}/${y}.png`. The pyramid is
 * sparse: tiles that contain no valid radiance sample are not written, so a
 * 404 inside the rendered zoom range is a known-empty tile and is answered
 * with a transparent PNG. Any other failure is a `RasterError`; there is no
 * fallback to the upstream WMS.
 */

export const SELF_HOSTED_BASE_URL_ENV = 'DARKMAP_RASTER_TILE_BASE_URL';

export interface SelfHostedLayerBinding {
	/** Path segment under the store base, e.g. `vnp46a4-002/2019`. */
	readonly path: string;
	/** Highest rendered zoom. Requests beyond it get a transparent tile. */
	readonly maxZoom: number;
}

export interface SelfHostedTileConfig {
	/** `https://…` or `file:///…`, without a trailing slash. */
	readonly baseUrl: string;
	/** Keyed by the layer's `upstreamLayer` (the RasterTileRequest key). */
	readonly layers: ReadonlyMap<string, SelfHostedLayerBinding>;
}

export interface SelfHostedLayerSource {
	readonly upstreamLayer?: string;
	readonly selfHostedPath?: string;
	readonly maxNativeZoom?: number;
}

/** Fully transparent 256 × 256 RGBA PNG (334 bytes). */
export const TRANSPARENT_TILE_PNG: Uint8Array = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAABFUlEQVR42u3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMBPAAB2ClDBAAAAABJRU5ErkJggg==',
	),
	(c) => c.charCodeAt(0),
);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const isPng = (bytes: Uint8Array): boolean =>
	bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);

/**
 * Build the self-hosted config from the environment and the layer manifest.
 * Returns `undefined` when the base URL is unset (the server then keeps the
 * legacy upstream client). An invalid base URL throws so a misconfigured
 * deployment fails loudly at the first request instead of serving wrong data.
 */
export const resolveSelfHostedTileConfig = (
	baseUrl: string | undefined,
	layers: ReadonlyArray<SelfHostedLayerSource>,
): SelfHostedTileConfig | undefined => {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`${SELF_HOSTED_BASE_URL_ENV} is not a URL`);
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
		throw new Error(`${SELF_HOSTED_BASE_URL_ENV} must be https:// or file://`);
	}
	if (parsed.search || parsed.hash || parsed.username || parsed.password) {
		throw new Error(`${SELF_HOSTED_BASE_URL_ENV} must not carry a query, fragment or credentials`);
	}
	const bindings = new Map<string, SelfHostedLayerBinding>();
	for (const layer of layers) {
		if (!layer.upstreamLayer || !layer.selfHostedPath || layer.maxNativeZoom === undefined) continue;
		bindings.set(layer.upstreamLayer, { path: layer.selfHostedPath, maxZoom: layer.maxNativeZoom });
	}
	return { baseUrl: parsed.href.replace(/\/+$/, ''), layers: bindings };
};

export interface SelfHostedTileIo {
	readonly fetch?: typeof globalThis.fetch;
	/** Reads a local file; resolves `null` when it does not exist. */
	readonly readFile?: (path: string) => Promise<Uint8Array | null>;
}

const readLocal = async (path: string): Promise<Uint8Array | null> => {
	try {
		return new Uint8Array(await readFile(path));
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
		throw cause;
	}
};

const transparent = (): RasterResponse => ({
	contentType: 'image/png',
	body: new Uint8Array(TRANSPARENT_TILE_PNG),
});

export const selfHostedTileUrl = (
	config: SelfHostedTileConfig,
	binding: SelfHostedLayerBinding,
	tile: { readonly z: number; readonly x: number; readonly y: number },
): string => `${config.baseUrl}/${binding.path}/${tile.z}/${tile.x}/${tile.y}.png`;

export const makeSelfHostedRasterClient = (
	config: SelfHostedTileConfig,
	io: SelfHostedTileIo = {},
): Layer.Layer<RasterClient> =>
	Layer.succeed(
		RasterClient,
		RasterClient.of({
			getTile: ({ upstreamLayer, tile }) =>
				Effect.gen(function* () {
					const binding = config.layers.get(upstreamLayer);
					if (!binding) {
						return yield* Effect.fail(
							new RasterError({ status: 404, upstream: `self-hosted:${upstreamLayer}` }),
						);
					}
					// Clients overzoom past maxNativeZoom; an older cached bundle may
					// still ask deeper. Answer with an empty tile, never a wrong one.
					if (tile.z > binding.maxZoom) return transparent();

					const target = selfHostedTileUrl(config, binding, tile);
					let bytes: Uint8Array | null;
					if (target.startsWith('file:')) {
						const reader = io.readFile ?? readLocal;
						bytes = yield* Effect.tryPromise({
							try: () => reader(fileURLToPath(target)),
							catch: (cause) => new RasterError({ status: 502, upstream: target, cause }),
						});
					} else {
						const doFetch = io.fetch ?? globalThis.fetch;
						const res = yield* Effect.tryPromise({
							try: () => doFetch(target),
							catch: (cause) => new RasterError({ status: 502, upstream: target, cause }),
						});
						if (res.status === 404) {
							bytes = null;
						} else if (!res.ok) {
							return yield* Effect.fail(new RasterError({ status: 502, upstream: target }));
						} else {
							const buffer = yield* Effect.tryPromise({
								try: () => res.arrayBuffer(),
								catch: (cause) => new RasterError({ status: 502, upstream: target, cause }),
							});
							bytes = new Uint8Array(buffer);
						}
					}
					if (bytes === null) return transparent();
					if (!isPng(bytes)) {
						return yield* Effect.fail(new RasterError({ status: 502, upstream: target }));
					}
					return { contentType: 'image/png', body: bytes };
				}),
		}),
	);
