/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

/**
 * darkmap service worker — app-shell precache + per-bucket runtime caches
 * (GH #100). Cache buckets are named with stable prefixes so the
 * `OfflineCacheServiceBrowser` adapter can attribute entries back to the
 * `CacheEntryMeta.bucket` taxonomy without sniffing URLs at snapshot time.
 *
 * Cache shape:
 *   `darkmap-app-shell-v${version}`  → precached SvelteKit build/files/prerendered
 *   `darkmap-raster-tile`            → /api/raster/* responses
 *   `darkmap-ephemeris`              → /api/featureinfo, /api/elevation
 *   `darkmap-static-projection`      → checked-in projection JSON
 *   `darkmap-route`                  → reserved for user-imported routes
 *
 * Out of scope for this PR (intentional):
 *   - Push notifications, background sync, periodic sync.
 *   - Cache TTL eviction inside the SW (handled by OfflineCacheService.evict
 *     from the page side; SW only writes).
 *   - Workbox / sw-toolbox — we own ~150 lines and skip the framework debt.
 */

import { build, files, prerendered, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const APP_SHELL = `darkmap-app-shell-v${version}`;
const RASTER_TILE = 'darkmap-raster-tile';
const EPHEMERIS = 'darkmap-ephemeris';
const STATIC_PROJECTION = 'darkmap-static-projection';

const RUNTIME_BUCKETS = [RASTER_TILE, EPHEMERIS, STATIC_PROJECTION, 'darkmap-route'] as const;

const ASSETS = [...build, ...files, ...prerendered];

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(APP_SHELL);
			await cache.addAll(ASSETS);
			await sw.skipWaiting();
		})(),
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(
				keys.map((key) => {
					// Drop old app-shell versions; keep runtime buckets across deploys
					// so a cached raster tile survives a JS rebuild.
					if (key.startsWith('darkmap-app-shell-') && key !== APP_SHELL) {
						return caches.delete(key);
					}
					return undefined;
				}),
			);
			await sw.clients.claim();
		})(),
	);
});

sw.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== sw.location.origin) return;

	// /api/raster/* — opaque PNG tiles, cache-first, store in raster bucket.
	if (url.pathname.startsWith('/api/raster/')) {
		event.respondWith(cacheFirst(request, RASTER_TILE));
		return;
	}

	// /api/featureinfo and /api/elevation — small JSON, cache-first.
	if (url.pathname.startsWith('/api/featureinfo') || url.pathname.startsWith('/api/elevation')) {
		event.respondWith(cacheFirst(request, EPHEMERIS));
		return;
	}

	// Static-projection JSON.
	if (url.pathname.startsWith('/projection/')) {
		event.respondWith(cacheFirst(request, STATIC_PROJECTION));
		return;
	}

	// Skip /api/geocode — search queries vary too widely to cache effectively.
	if (url.pathname.startsWith('/api/')) return;

	// HTML navigations — network-first with offline fallback to app shell.
	if (request.mode === 'navigate') {
		event.respondWith(networkFirst(request, APP_SHELL));
		return;
	}

	// Same-origin static assets (already in APP_SHELL precache from build).
	if (ASSETS.includes(url.pathname)) {
		event.respondWith(cacheFirst(request, APP_SHELL));
		return;
	}
});

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
	const cache = await caches.open(cacheName);
	const cached = await cache.match(request);
	if (cached) return cached;
	const response = await fetch(request);
	if (response.ok && response.type !== 'opaqueredirect') {
		await cache.put(request, response.clone()).catch(() => {
			// Storage quota — fall through and serve the network response uncached.
		});
	}
	return response;
}

async function networkFirst(request: Request, cacheName: string): Promise<Response> {
	try {
		const response = await fetch(request);
		if (response.ok) {
			const cache = await caches.open(cacheName);
			await cache.put(request, response.clone()).catch(() => {});
		}
		return response;
	} catch (err) {
		const cache = await caches.open(cacheName);
		const cached = await cache.match(request);
		if (cached) return cached;
		// Last resort for navigations: serve the prerendered shell if present.
		const shellMatch = await cache.match('/');
		if (shellMatch) return shellMatch;
		throw err;
	}
}

// Re-exported only so unit tests can assert the bucket name contract without
// instantiating the SW global. Not consumed at runtime.
export const __test = {
	APP_SHELL_PREFIX: 'darkmap-app-shell-',
	RUNTIME_BUCKETS,
	RASTER_TILE,
	EPHEMERIS,
	STATIC_PROJECTION,
};
