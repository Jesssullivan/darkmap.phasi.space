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
	readonly now?: () => number;
}

export interface CacheFirstOptions {
	/** Normalize the cache key (collapse query-order-equivalent URLs). Default false. */
	readonly normalize?: boolean;
	/** Runtime responses obey their browser Cache-Control; app-shell remains unchanged. */
	readonly freshness?: boolean;
}

/** The key used for match/put: a normalized URL string, or the raw Request. */
const keyFor = (request: Request, normalize: boolean): RequestInfo =>
	normalize ? normalizeCacheKey(new URL(request.url)) : request;

export const CACHE_WRITE_TIME_HEADER = 'x-darkmap-cached-at';
export const CACHE_BYTES_HEADER = 'x-darkmap-cache-bytes';

/** Legacy entries without a valid timestamp are unknown, never newly fresh. */
export const cacheWriteTime = (response: Response): number => {
	const value = response.headers.get(CACHE_WRITE_TIME_HEADER);
	if (value !== null && /^\d+$/.test(value)) {
		const parsed = Number(value);
		if (Number.isSafeInteger(parsed) && parsed <= 8.64e15) return parsed;
	}
	const date = Date.parse(response.headers.get('date') ?? '');
	return Number.isFinite(date) ? date : 0;
};

export const cacheResponseBytes = async (response: Response): Promise<number> => {
	const value = response.headers.get(CACHE_BYTES_HEADER);
	if (value !== null && /^\d+$/.test(value)) {
		const parsed = Number(value);
		if (Number.isSafeInteger(parsed)) return parsed;
	}
	return (await response.clone().arrayBuffer()).byteLength;
};

const fresh = (response: Response, now: number): boolean => {
	const control = response.headers.get('cache-control') ?? '';
	if (/\b(no-cache|no-store)\b/i.test(control)) return false;
	const maxAge = /(?:^|,)\s*max-age\s*=\s*(\d+)(?:\s|,|$)/i.exec(control);
	const written = cacheWriteTime(response);
	const age = Number(response.headers.get('age') ?? '0');
	return (
		written > 0 &&
		written <= now &&
		maxAge !== null &&
		Number.isFinite(age) &&
		age >= 0 &&
		now - written + age * 1000 < Number(maxAge[1]) * 1000
	);
};

const mayStore = (response: Response): boolean =>
	response.ok &&
	response.type !== 'opaqueredirect' &&
	response.type !== 'opaque' &&
	!/\bno-store\b/i.test(response.headers.get('cache-control') ?? '');

const withWriteMetadata = async (response: Response, now: number): Promise<Response> => {
	const body = await response.clone().arrayBuffer();
	const headers = new Headers(response.headers);
	// Fetch bodies are decoded; reconstructed cache bytes must describe that body.
	headers.delete('content-encoding');
	headers.set('content-length', String(body.byteLength));
	const originDate = Date.parse(response.headers.get('date') ?? '');
	const originAge = Number(response.headers.get('age') ?? '0');
	const initialAge = Math.max(
		Number.isFinite(originAge) && originAge >= 0 ? originAge : 0,
		Number.isFinite(originDate) ? Math.max(0, (now - originDate) / 1000) : 0,
	);
	headers.set('age', String(Math.ceil(initialAge)));
	headers.set(CACHE_WRITE_TIME_HEADER, String(now));
	headers.set(CACHE_BYTES_HEADER, String(body.byteLength));
	return new Response(body, { status: response.status, statusText: response.statusText, headers });
};

// Scope deduplication to a storage adapter as well as cache/key (tests and seats
// can own independent stores). Never share an already-consumed response body.
const pending = new WeakMap<CacheStorageLike, Map<string, Promise<Response>>>();

/** Response-local evidence: never rewrite stored measurement times on a cache hit. */
const cacheEvidence = (response: Response, state: 'fresh' | 'stale', now: number): Response => {
	const copy = response.clone();
	const headers = new Headers(copy.headers);
	headers.set('x-darkmap-runtime-cache', state);
	const written = cacheWriteTime(copy);
	const originAge = Number(copy.headers.get('age') ?? '0');
	if (written > 0 && written <= now && Number.isFinite(originAge) && originAge >= 0) {
		headers.set('age', String(Math.ceil(originAge + (now - written) / 1000)));
	}
	if (state === 'stale') headers.set('warning', '110 darkmap "Response is stale"');
	return new Response(copy.body, { status: copy.status, statusText: copy.statusText, headers });
};

export async function cacheFirst(
	deps: RuntimeCacheDeps,
	request: Request,
	cacheName: string,
	opts: CacheFirstOptions = {},
): Promise<Response> {
	const key = keyFor(request, opts.normalize ?? false);
	let cache: CacheLike | undefined;
	let match: Response | undefined;
	try {
		cache = await deps.caches.open(cacheName);
		match = await cache.match(key);
	} catch {
		// Disabled/private/quota-denied Cache Storage must not deny online data.
		cache = undefined;
	}
	const cached = opts.freshness && match && !mayStore(match) ? undefined : match;
	if (cached && (!opts.freshness || fresh(cached, (deps.now ?? Date.now)()))) {
		return opts.freshness ? cacheEvidence(cached, 'fresh', (deps.now ?? Date.now)()) : cached;
	}
	const fallback = () => (cached && opts.freshness ? cacheEvidence(cached, 'stale', (deps.now ?? Date.now)()) : cached);
	let active = pending.get(deps.caches);
	if (!active) {
		active = new Map();
		pending.set(deps.caches, active);
	}
	const identity = `${cacheName}\0${typeof key === 'string' ? key : key instanceof URL ? key.href : key.url}`;
	const existing = active.get(identity);
	if (existing) return (await existing).clone();
	const operation = (async () => {
		try {
			const response = await deps.fetch(request);
			if (mayStore(response)) {
				try {
					if (!cache) return response;
					const stored = opts.freshness
						? await withWriteMetadata(response, (deps.now ?? Date.now)())
						: response.clone();
					await cache.put(key, stored);
				} catch {
					/* Quota or storage failure: keep prior cache and serve successful network bytes. */
				}
				return response;
			}
			return response.ok && response.type !== 'opaqueredirect' && response.type !== 'opaque'
				? response
				: (fallback() ?? response);
		} catch (error) {
			if (cached) return fallback()!;
			throw error;
		}
	})();
	active.set(identity, operation);
	try {
		return (await operation).clone();
	} finally {
		active.delete(identity);
	}
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
			try {
				const cache = await deps.caches.open(cacheName);
				await cache.put(request, response.clone());
			} catch {
				// Storage availability is not a condition for serving successful network bytes.
			}
		}
		return response;
	} catch (err) {
		try {
			const cache = await deps.caches.open(cacheName);
			const cached = await cache.match(request);
			if (cached) return cached;
			const shellMatch = await cache.match('/');
			if (shellMatch) return shellMatch;
		} catch {
			// Preserve the actual network failure when offline storage is unavailable too.
		}
		throw err;
	}
}
