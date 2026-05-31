/**
 * Atmospheric tile protocol loader (#248).
 *
 * Problem: the `/api/raster?kind=atmospheric` proxy already classifies
 * every GIBS tile as `ok` / `no-data` / upstream-error and emits the
 * verdict in an `x-darkmap-atmospheric-outcome` response header — but a
 * MapLibre raster source fetches tiles internally and never exposes
 * response headers to us. So a transparent no-data PNG loads as a valid
 * 200 image and the generic `sourcedata` handler flips the layer to
 * `rendered` ("live"), even when every tile is empty. Field users saw a
 * green "live" pill over regions with zero coverage.
 *
 * Fix: register a MapLibre custom protocol (`addProtocol`) for
 * atmospheric tiles. The loader does the fetch itself, reads the outcome
 * header, dispatches the right health event into the `HealthRegistry`,
 * and returns the image bytes to MapLibre. This is the "Atmospheric
 * fetch wrappers that read x-darkmap-atmospheric-outcome" producer the
 * HealthRegistry doc names.
 *
 * Aggregation note: a layer covers many tiles, and partial coverage is
 * normal (some tiles carry data, some are no-data). "Any real tile wins"
 * is the correct rule, so the loader suppresses a `tile-empty` dispatch
 * once the layer has reached `rendered`. That keeps the any-ok-wins logic
 * atmospheric-specific and leaves the global reducer (and OpenAQ's
 * latest-wins semantics) untouched.
 *
 * The loader is a pure factory over its deps (fetch + registry accessors)
 * so it unit-tests without MapLibre or a browser.
 */

import { rasterUrlTemplate, type RasterUrlTemplateOptions } from '$lib/layers';
import type { HealthEvent, LayerHealth } from '$lib/layers/health-state';

/** Custom MapLibre protocol scheme. Atmospheric tile templates are prefixed with `${ATMO_PROTOCOL}://`. */
export const ATMO_PROTOCOL = 'darkmapatmo';

const SCHEME_PREFIX = `${ATMO_PROTOCOL}://`;

/** Wrap a relative `/api/raster?...` template so MapLibre routes it through our protocol loader. */
export const withAtmoScheme = (url: string): string => `${SCHEME_PREFIX}${url}`;

/** Strip the custom scheme back to the real fetchable URL. */
export const stripAtmoScheme = (url: string): string =>
	url.startsWith(SCHEME_PREFIX) ? url.slice(SCHEME_PREFIX.length) : url;

/** Build the scheme-prefixed tile template for an atmospheric layer id. */
export const atmosphericTileTemplate = (layerId: string, options: RasterUrlTemplateOptions = {}): string =>
	withAtmoScheme(rasterUrlTemplate(layerId, options));

/** Extract the `layer` query param from a (possibly schemed, possibly relative) tile URL. */
export const layerIdFromTileUrl = (url: string): string | undefined => {
	const real = stripAtmoScheme(url);
	const qIndex = real.indexOf('?');
	if (qIndex < 0) return undefined;
	const params = new URLSearchParams(real.slice(qIndex + 1));
	return params.get('layer') ?? undefined;
};

export interface AtmosphericLoaderDeps {
	/** Injected for tests; defaults to global fetch at the call site. */
	readonly fetchImpl: typeof fetch;
	/** Read current health so the loader can apply any-ok-wins for no-data tiles. */
	readonly getHealth: (layerId: string) => LayerHealth;
	readonly dispatch: (layerId: string, event: HealthEvent) => void;
}

/** Minimal shape of the MapLibre v5 protocol-loader request/abort args (avoids importing maplibre types). */
export interface AtmoRequestParameters {
	readonly url: string;
}
export interface AtmoAbortController {
	readonly signal: AbortSignal;
}
export interface AtmoLoaderResult {
	readonly data: ArrayBuffer;
}

const isAbortError = (e: unknown): boolean =>
	e instanceof DOMException
		? e.name === 'AbortError'
		: Boolean(e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError');

/**
 * Build the MapLibre `addProtocol` loader. Returns image bytes for every
 * tile (including the transparent no-data PNG, which MapLibre renders as
 * an empty tile) and dispatches a health event as a side effect:
 *
 *   - non-2xx response            → `tile-error` (status carried through)
 *   - 2xx, outcome=`no-data`      → `tile-empty` (unless already rendered)
 *   - 2xx, outcome=`ok`/absent    → `tile-ok`
 *   - fetch aborted (pan/zoom)    → rethrow, NO dispatch (it's our own cancel)
 */
export const makeAtmosphericTileLoader =
	(deps: AtmosphericLoaderDeps) =>
	async (params: AtmoRequestParameters, abortController: AtmoAbortController): Promise<AtmoLoaderResult> => {
		const realUrl = stripAtmoScheme(params.url);
		const layerId = layerIdFromTileUrl(params.url);

		let res: Response;
		try {
			res = await deps.fetchImpl(realUrl, { signal: abortController.signal });
		} catch (e) {
			if (isAbortError(e)) throw e; // our own cancellation — not a layer error
			if (layerId) deps.dispatch(layerId, { type: 'tile-error', reason: errorMessage(e) });
			throw e;
		}

		if (!res.ok) {
			if (layerId) {
				deps.dispatch(layerId, {
					type: 'tile-error',
					reason: `upstream ${res.status}`,
					status: res.status,
				});
			}
			// Surface to MapLibre as a failed tile.
			throw new Error(`atmospheric tile ${res.status}`);
		}

		const outcome = res.headers.get('x-darkmap-atmospheric-outcome');
		if (layerId) {
			if (outcome === 'no-data') {
				// Any-ok-wins: don't downgrade a layer that already rendered real tiles.
				if (deps.getHealth(layerId).tag !== 'rendered') {
					deps.dispatch(layerId, { type: 'tile-empty', reason: 'no coverage for this date / area' });
				}
			} else {
				deps.dispatch(layerId, { type: 'tile-ok' });
			}
		}

		const data = await res.arrayBuffer();
		return { data };
	};

const errorMessage = (e: unknown): string =>
	e instanceof Error ? e.message : typeof e === 'string' ? e : 'atmospheric tile fetch failed';
