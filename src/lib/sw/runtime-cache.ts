/**
 * Service-worker runtime caching strategies (#254).
 *
 * Extracted from `service-worker.ts` so the cache-key behavior is
 * unit-testable without the SW global / `$service-worker` virtual module.
 *
 * The key change vs the inline version: runtime API responses (raster,
 * atmospheric, ephemeris, static-projection) are stored under a
 * NORMALIZED cache key (`normalizeCacheKey`) instead of the raw
 * `Request`. MapLibre and the app emit functionally-identical tile URLs
 * that differ only in query-param order; keyed by raw Request they
 * fragment the cache (a real cost for mobile/offline map use). Normalized
 * keys collapse `?z=4&x=3` and `?x=3&z=4` to one entry while preserving
 * every param value (only ordering is canonicalized — see
 * `normalizeCacheKey`), so semantically-distinct requests stay distinct.
 *
 * App-shell assets and navigations are NOT normalized: their paths are
 * exact and case-sensitive (`normalize: false`, the default).
 */

import { normalizeCacheKey } from '$lib/effect/services/OfflineCacheRoutes';

/** Structural subset of the Cache API we depend on (so tests pass a fake). */
export interface CacheLike {
	match(request: RequestInfo | URL): Promise<Response | undefined>;
	put(request: RequestInfo | URL, response: Response): Promise<void>;
}
export interface CacheStorageLike {
	open(cacheName: string): Promise<CacheLike>;
}
export interface RuntimeCacheDeps {
	readonly caches: CacheStorageLike;
	readonly fetch: typeof fetch;
}

export interface CacheFirstOptions {
	/** Normalize the cache key (collapse query-order-equivalent URLs). Default false. */
	readonly normalize?: boolean;
}

/** The key used for match/put: a normalized URL string, or the raw Request. */
const keyFor = (request: Request, normalize: boolean): RequestInfo =>
	normalize ? normalizeCacheKey(new URL(request.url)) : request;

/**
 * Cache-first: serve a cached response if present, else fetch, cache a
 * successful response, and return it. Quota failures fall through to an
 * uncached network response.
 */
export async function cacheFirst(
	deps: RuntimeCacheDeps,
	request: Request,
	cacheName: string,
	opts: CacheFirstOptions = {},
): Promise<Response> {
	const key = keyFor(request, opts.normalize ?? false);
	const cache = await deps.caches.open(cacheName);
	const cached = await cache.match(key);
	if (cached) return cached;
	const response = await deps.fetch(request);
	if (response.ok && response.type !== 'opaqueredirect') {
		await cache.put(key, response.clone()).catch(() => {
			// Storage quota — serve the network response uncached.
		});
	}
	return response;
}

/**
 * Network-first with cache fallback (navigations / app shell). Never
 * normalized — navigations are exact.
 */
export async function networkFirst(deps: RuntimeCacheDeps, request: Request, cacheName: string): Promise<Response> {
	try {
		const response = await deps.fetch(request);
		// Mirror cacheFirst's guard: an opaqueredirect response is uncloneable and
		// cache.put would throw, so skip it (a redirected navigation just isn't
		// cached rather than silently failing the put).
		if (response.ok && response.type !== 'opaqueredirect') {
			const cache = await deps.caches.open(cacheName);
			await cache.put(request, response.clone()).catch(() => {});
		}
		return response;
	} catch (err) {
		const cache = await deps.caches.open(cacheName);
		const cached = await cache.match(request);
		if (cached) return cached;
		const shellMatch = await cache.match('/');
		if (shellMatch) return shellMatch;
		throw err;
	}
}
