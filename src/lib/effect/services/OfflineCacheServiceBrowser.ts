import { Layer } from 'effect';
import { cacheWriteTime, cacheResponseBytes } from '$lib/sw/runtime-cache';
import {
	makeOfflineCacheServiceLive,
	OfflineCacheService,
	type CacheEntryMeta,
	type OfflineCacheAdapter,
} from './OfflineCacheService';

/**
 * Browser adapter for `OfflineCacheService` (GH #100). Binds the
 * `OfflineCacheAdapter` interface to `navigator.serviceWorker` registration
 * and the `caches` Storage API. Cache buckets are inferred from the cache
 * name prefix written by `src/service-worker.ts` — keep this map in lock-step
 * with the SW.
 *
 * Pure function: takes browser globals as deps so Vitest can inject fakes
 * without polluting any module state.
 */

const SW_URL = '/service-worker.js';
const SW_SCOPE = '/';

/** Map a Cache Storage cache name to a `CacheEntryMeta.bucket`. */
const bucketForCacheName = (name: string): CacheEntryMeta['bucket'] => {
	if (name.startsWith('darkmap-app-shell-')) return 'app-shell';
	if (name === 'darkmap-raster-tile') return 'raster-tile';
	if (name === 'darkmap-atmospheric-tile') return 'atmospheric-tile';
	if (name === 'darkmap-ephemeris') return 'ephemeris';
	if (name === 'darkmap-static-projection') return 'static-projection';
	if (name === 'darkmap-route') return 'route';
	// Unknown caches default to raster-tile so eviction policies still apply.
	return 'raster-tile';
};

/** Cache-name predicate. Anything outside the darkmap prefix is ignored. */
const isDarkmapCache = (name: string): boolean => name.startsWith('darkmap-');

export interface BrowserAdapterDeps {
	readonly serviceWorker?: ServiceWorkerContainer;
	readonly caches?: CacheStorage;
	readonly now?: () => string;
}

/**
 * Build an `OfflineCacheAdapter` from a set of browser-style deps. Defaults
 * read from the global `navigator` / `caches`; in Vitest, callers pass fakes.
 */
export const makeBrowserAdapter = (deps: BrowserAdapterDeps = {}): OfflineCacheAdapter => {
	const sw = deps.serviceWorker ?? (typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined);
	const cacheStorage = deps.caches ?? (typeof caches !== 'undefined' ? caches : undefined);

	return {
		isSupported: () => Boolean(sw) && Boolean(cacheStorage),

		register: async () => {
			if (!sw) throw new Error('serviceWorker container unavailable');
			await sw.register(SW_URL, { scope: SW_SCOPE });
		},

		unregister: async () => {
			if (!sw) return;
			const registrations = await sw.getRegistrations();
			await Promise.all(registrations.map((reg) => reg.unregister()));
		},

		snapshot: async () => {
			if (!cacheStorage) {
				return { registered: false, entries: [] };
			}
			const registered = sw ? (await sw.getRegistrations()).length > 0 : false;
			const cacheNames = (await cacheStorage.keys()).filter(isDarkmapCache);
			const entries: CacheEntryMeta[] = [];
			for (const cacheName of cacheNames) {
				const cache = await cacheStorage.open(cacheName);
				const requests = await cache.keys();
				const bucket = bucketForCacheName(cacheName);
				for (const req of requests) {
					const response = await cache.match(req);
					const bytes = response ? await cacheResponseBytes(response) : 0;
					entries.push({
						key: cacheKeyFor(cacheName, req),
						bytes,
						storedAt: new Date(response ? cacheWriteTime(response) : 0).toISOString(),
						bucket,
					});
				}
			}
			const latest = entries.reduce((value, entry) => Math.max(value, Date.parse(entry.storedAt)), 0);
			return { registered, entries, lastUpdated: latest > 0 ? new Date(latest).toISOString() : undefined };
		},

		drop: async (key) => {
			if (!cacheStorage) return 0;
			const parsed = parseCacheKey(key);
			if (!parsed) return 0;
			const cache = await cacheStorage.open(parsed.cacheName);
			const response = await cache.match(parsed.url);
			if (!response) return 0;
			const bytes = response ? await cacheResponseBytes(response) : 0;
			const removed = await cache.delete(parsed.url);
			return removed ? bytes : 0;
		},
	};
};

/**
 * The cache key embeds the cache name so `drop` can route deletions back to
 * the right cache without a separate index. Format: `${cacheName}|${url}`.
 */
const cacheKeyFor = (cacheName: string, req: Request): string => `${cacheName}|${req.url}`;

const parseCacheKey = (key: string): { cacheName: string; url: string } | null => {
	const idx = key.indexOf('|');
	if (idx < 0) return null;
	return { cacheName: key.slice(0, idx), url: key.slice(idx + 1) };
};

/**
 * Live `OfflineCacheService` Layer wired to the real browser. Reads `navigator`
 * and `caches` lazily inside `makeBrowserAdapter` so server-rendered code that
 * imports this module doesn't immediately blow up.
 */
export const OfflineCacheServiceBrowserLive: Layer.Layer<OfflineCacheService> = Layer.suspend(() =>
	makeOfflineCacheServiceLive(makeBrowserAdapter()),
);

/** Test/preview helper — accepts injected deps directly. */
export const makeOfflineCacheServiceBrowserLayer = (deps: BrowserAdapterDeps): Layer.Layer<OfflineCacheService> =>
	makeOfflineCacheServiceLive(makeBrowserAdapter(deps));
