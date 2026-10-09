import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Effect, Layer } from 'effect';
import { RasterClient, RasterError, fetchUpstreamTile, type RasterResponse, type RasterTileRequest } from './RasterClient';

/**
 * Self-hosted raster tiles (RV1, RV12, RV13; TIN-1287 / GH #103).
 *
 * Layers that declare a `selfHosted` binding in `layers.ts` are served only
 * from our own pre-rendered XYZ PNG store, never from the third-party
 * GeoServer. The store is any HTTPS origin or a local directory (`file://`,
 * used for local proofs and the read-only PVC in ns darkmap).
 *
 * Layout: `${base}/${binding.path}/${z}/${x}/${y}.png`, plus
 * `${base}/${binding.path}/manifest.json` written by the pyramid tooling
 * (`scripts/raster-pilot/gibs_mirror.py` or `pyramid.py`).
 *
 * - The manifest must exist before any tile is served. A missing or empty
 *   store (unmounted volume, wrong base path, unset variable) is a 503, not a
 *   transparent tile, so an outage cannot hide behind a green smoke.
 * - Inside a present pyramid, a missing tile is a known-empty (sparse) tile
 *   and is answered with a transparent PNG.
 * - Layers without a binding (World Atlas, the other VIIRS years) keep the
 *   upstream WMS client.
 */

export const SELF_HOSTED_BASE_URL_ENV = 'DARKMAP_RASTER_TILE_BASE_URL';

export interface SelfHostedBinding {
	/** Path segment under the store base, e.g. `gibs-viirs-black-marble/2016`. */
	readonly path: string;
	/** Highest rendered zoom. Requests beyond it get a transparent tile. */
	readonly maxZoom: number;
	/** Short provenance string exposed as `x-darkmap-raster-product`. */
	readonly product: string;
}

export interface SelfHostedTileConfig {
	/** `https://…` or `file:///…` without a trailing slash; undefined when unset. */
	readonly baseUrl: string | undefined;
	/** Keyed by the layer's `upstreamLayer` (the RasterTileRequest key). */
	readonly layers: ReadonlyMap<string, SelfHostedBinding>;
}

export interface SelfHostedLayerSource {
	readonly upstreamLayer?: string;
	readonly selfHosted?: SelfHostedBinding;
}

/** Fully transparent 256 × 256 RGBA PNG (334 bytes; IDAT inflates to 256 × 1025 zero bytes). */
export const TRANSPARENT_TILE_PNG: Uint8Array = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAABFUlEQVR42u3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMBPAAB2ClDBAAAAABJRU5ErkJggg==',
	),
	(c) => c.charCodeAt(0),
);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const isPng = (bytes: Uint8Array): boolean =>
	bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);

/**
 * Build the self-hosted config from the environment and the layer manifest.
 * Bindings come from `layers.ts` regardless of the environment; `baseUrl` is
 * undefined when the variable is unset. An invalid base URL throws so a
 * misconfigured deployment fails loudly instead of serving wrong data.
 */
export const resolveSelfHostedTileConfig = (
	baseUrl: string | undefined,
	layers: ReadonlyArray<SelfHostedLayerSource>,
): SelfHostedTileConfig => {
	const bindings = new Map<string, SelfHostedBinding>();
	for (const layer of layers) {
		if (!layer.upstreamLayer || !layer.selfHosted) continue;
		bindings.set(layer.upstreamLayer, layer.selfHosted);
	}
	const trimmed = baseUrl?.trim();
	if (!trimmed) return { baseUrl: undefined, layers: bindings };
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
	return { baseUrl: parsed.href.replace(/\/+$/, ''), layers: bindings };
};

export interface SelfHostedTileIo {
	readonly fetch?: typeof globalThis.fetch;
	/** Reads a local file; resolves `null` when it does not exist. */
	readonly readFile?: (path: string) => Promise<Uint8Array | null>;
	/** Client for layers without a binding (defaults to the upstream WMS). */
	readonly upstream?: (req: RasterTileRequest) => Effect.Effect<RasterResponse, RasterError>;
	/** Clock for the manifest re-check interval (tests). */
	readonly now?: () => number;
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
	baseUrl: string,
	binding: SelfHostedBinding,
	tile: { readonly z: number; readonly x: number; readonly y: number },
): string => `${baseUrl}/${binding.path}/${tile.z}/${tile.x}/${tile.y}.png`;

export const selfHostedManifestUrl = (baseUrl: string, binding: SelfHostedBinding): string =>
	`${baseUrl}/${binding.path}/manifest.json`;

/** A missing manifest is re-checked at most this often (ms). */
export const MANIFEST_RECHECK_MS = 30_000;

/**
 * The raster client for the whole route: bound layers read the self-hosted
 * store, everything else goes to `io.upstream` (the legacy WMS client).
 */
export const makeSelfHostedRasterClient = (
	config: SelfHostedTileConfig,
	io: SelfHostedTileIo = {},
): Layer.Layer<RasterClient> => {
	const upstream = io.upstream ?? fetchUpstreamTile;
	const now = io.now ?? Date.now;
	const reader = io.readFile ?? readLocal;
	// path -> verified, or the time of the last failed check.
	const manifests = new Map<string, true | number>();

	/** Reads one store object; `null` means "not there". */
	const readObject = (target: string): Effect.Effect<Uint8Array | null, RasterError> =>
		target.startsWith('file:')
			? Effect.tryPromise({
					try: () => reader(fileURLToPath(target)),
					catch: (cause) => new RasterError({ status: 502, upstream: target, cause }),
				})
			: Effect.gen(function* () {
					const doFetch = io.fetch ?? globalThis.fetch;
					const res = yield* Effect.tryPromise({
						try: () => doFetch(target),
						catch: (cause) => new RasterError({ status: 502, upstream: target, cause }),
					});
					if (res.status === 404) return null;
					if (!res.ok) return yield* Effect.fail(new RasterError({ status: 502, upstream: target }));
					const buffer = yield* Effect.tryPromise({
						try: () => res.arrayBuffer(),
						catch: (cause) => new RasterError({ status: 502, upstream: target, cause }),
					});
					return new Uint8Array(buffer);
				});

	const ensureManifest = (baseUrl: string, binding: SelfHostedBinding): Effect.Effect<void, RasterError> =>
		Effect.gen(function* () {
			const state = manifests.get(binding.path);
			if (state === true) return;
			const target = selfHostedManifestUrl(baseUrl, binding);
			if (typeof state === 'number' && now() - state < MANIFEST_RECHECK_MS) {
				return yield* Effect.fail(new RasterError({ status: 503, upstream: target }));
			}
			const bytes = yield* readObject(target).pipe(
				Effect.catch((err) => {
					manifests.set(binding.path, now());
					return Effect.fail(new RasterError({ status: 503, upstream: target, cause: err }));
				}),
			);
			let valid = false;
			if (bytes !== null) {
				try {
					const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
					valid = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
				} catch {
					valid = false;
				}
			}
			if (!valid) {
				manifests.set(binding.path, now());
				return yield* Effect.fail(new RasterError({ status: 503, upstream: target }));
			}
			manifests.set(binding.path, true);
		});

	return Layer.succeed(
		RasterClient,
		RasterClient.of({
			getTile: (req) =>
				Effect.gen(function* () {
					const binding = config.layers.get(req.upstreamLayer);
					if (!binding) return yield* upstream(req);
					const baseUrl = config.baseUrl;
					// A bound layer is labelled as its self-hosted product, so it is
					// never served from the upstream, even when the store is unset.
					if (!baseUrl) {
						return yield* Effect.fail(
							new RasterError({ status: 503, upstream: `self-hosted:unconfigured:${binding.path}` }),
						);
					}
					yield* ensureManifest(baseUrl, binding);
					// Clients overzoom past maxNativeZoom; an older cached bundle may
					// still ask deeper. Answer with an empty tile, never a wrong one.
					const { tile } = req;
					if (tile.z > binding.maxZoom) return transparent();

					const target = selfHostedTileUrl(baseUrl, binding, tile);
					const bytes = yield* readObject(target);
					if (bytes === null) return transparent();
					if (!isPng(bytes)) {
						return yield* Effect.fail(new RasterError({ status: 502, upstream: target }));
					}
					return { contentType: 'image/png', body: bytes };
				}),
		}),
	);
};
