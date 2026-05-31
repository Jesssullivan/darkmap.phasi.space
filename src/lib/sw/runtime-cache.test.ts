import { describe, expect, it, vi } from 'vitest';
import { cacheFirst, networkFirst, type CacheStorageLike, type RuntimeCacheDeps } from './runtime-cache';

/* A Map-backed fake Cache Storage keyed by the string URL of whatever
 * (string | URL | Request) is passed to match/put — mirrors how the real
 * Cache API canonicalizes keys by URL. */
const keyStr = (k: RequestInfo | URL): string => (typeof k === 'string' ? k : k instanceof URL ? k.toString() : k.url);

const makeCaches = () => {
	const store = new Map<string, Map<string, Response>>();
	const storage: CacheStorageLike = {
		open: async (name: string) => {
			let bucket = store.get(name);
			if (!bucket) {
				bucket = new Map();
				store.set(name, bucket);
			}
			const b = bucket;
			return {
				match: async (req) => b.get(keyStr(req)),
				put: async (req, res) => void b.set(keyStr(req), res),
			};
		},
	};
	return { storage, store };
};

const req = (url: string): Request => new Request(`https://darkmap.example${url}`);
const okResponse = () => new Response('tile-bytes', { status: 200 });

describe('cacheFirst — normalized runtime keys (#254)', () => {
	it('collapses query-order-equivalent raster URLs to a single cache entry', async () => {
		const { storage, store } = makeCaches();
		const fetchImpl = vi.fn().mockResolvedValue(okResponse());
		const deps: RuntimeCacheDeps = { caches: storage, fetch: fetchImpl };

		// First request populates the cache under the normalized key.
		await cacheFirst(
			deps,
			req('/api/raster?layer=viirs_2019&z=4&x=3&y=2&kind=atmospheric'),
			'darkmap-atmospheric-tile',
			{
				normalize: true,
			},
		);
		// Second request: same params, different ORDER → must hit the cache, no second fetch.
		const second = await cacheFirst(
			deps,
			req('/api/raster?y=2&kind=atmospheric&x=3&z=4&layer=viirs_2019'),
			'darkmap-atmospheric-tile',
			{ normalize: true },
		);

		expect(await second.text()).toBe('tile-bytes');
		expect(fetchImpl).toHaveBeenCalledTimes(1); // served from cache the 2nd time
		expect(store.get('darkmap-atmospheric-tile')!.size).toBe(1); // one entry, not two
	});

	it('keeps semantically-distinct params as separate entries', async () => {
		const { storage, store } = makeCaches();
		const fetchImpl = vi.fn().mockResolvedValue(okResponse());
		const deps: RuntimeCacheDeps = { caches: storage, fetch: fetchImpl };
		await cacheFirst(deps, req('/api/raster?layer=viirs_2019&z=4&x=3&y=2'), 'darkmap-raster-tile', { normalize: true });
		await cacheFirst(deps, req('/api/raster?layer=viirs_2018&z=4&x=3&y=2'), 'darkmap-raster-tile', { normalize: true });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(store.get('darkmap-raster-tile')!.size).toBe(2);
	});

	it('without normalize, query-order variants fragment into separate entries (app-shell semantics)', async () => {
		const { storage, store } = makeCaches();
		const fetchImpl = vi.fn().mockResolvedValue(okResponse());
		const deps: RuntimeCacheDeps = { caches: storage, fetch: fetchImpl };
		await cacheFirst(deps, req('/x?a=1&b=2'), 'darkmap-app-shell-v1');
		await cacheFirst(deps, req('/x?b=2&a=1'), 'darkmap-app-shell-v1');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(store.get('darkmap-app-shell-v1')!.size).toBe(2);
	});

	it('does not cache a non-ok response', async () => {
		const { storage, store } = makeCaches();
		const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 502 }));
		const deps: RuntimeCacheDeps = { caches: storage, fetch: fetchImpl };
		await cacheFirst(deps, req('/api/raster?z=1'), 'darkmap-raster-tile', { normalize: true });
		expect(store.get('darkmap-raster-tile')?.size ?? 0).toBe(0);
	});

	it('survives a cache.put quota failure by serving the network response', async () => {
		const storage: CacheStorageLike = {
			open: async () => ({
				match: async () => undefined,
				put: async () => {
					throw new Error('QuotaExceededError');
				},
			}),
		};
		const fetchImpl = vi.fn().mockResolvedValue(okResponse());
		const out = await cacheFirst({ caches: storage, fetch: fetchImpl }, req('/api/raster?z=1'), 'b', {
			normalize: true,
		});
		expect(await out.text()).toBe('tile-bytes');
	});
});

describe('networkFirst — navigations (never normalized)', () => {
	it('caches and returns a fresh navigation response', async () => {
		const { storage, store } = makeCaches();
		const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>', { status: 200 }));
		const out = await networkFirst({ caches: storage, fetch: fetchImpl }, req('/'), 'darkmap-app-shell-v1');
		expect(await out.text()).toBe('<html>');
		expect(store.get('darkmap-app-shell-v1')!.size).toBe(1);
	});

	it('falls back to the cached shell when the network throws', async () => {
		const { storage } = makeCaches();
		// Pre-seed the shell.
		const cache = await storage.open('darkmap-app-shell-v1');
		await cache.put('/', new Response('<cached-shell>', { status: 200 }));
		const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
		const out = await networkFirst({ caches: storage, fetch: fetchImpl }, req('/some/route'), 'darkmap-app-shell-v1');
		expect(await out.text()).toBe('<cached-shell>');
	});

	it('rethrows when offline and nothing is cached', async () => {
		const { storage } = makeCaches();
		const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
		await expect(
			networkFirst({ caches: storage, fetch: fetchImpl }, req('/some/route'), 'darkmap-app-shell-v1'),
		).rejects.toThrow(/offline/);
	});
});
