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
				match: async (req) => b.get(keyStr(req))?.clone(),
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

describe('cacheFirst — response freshness', () => {
	const url = '/api/raster?x=1&z=2';
	const name = 'darkmap-raster-tile';
	const now = 1_800_000_000_000;
	const options = { normalize: true, freshness: true };
	const seed = async (storage: CacheStorageLike, headers: HeadersInit = {}, bucket = name) => {
		const cache = await storage.open(bucket);
		await cache.put(req(url), new Response('old', { headers }));
	};

	it('records write time and measured body bytes without consuming the returned body', async () => {
		const { storage, store } = makeCaches();
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				new Response('tile-bytes', { headers: { 'cache-control': 'max-age=60', 'content-length': '999' } }),
			);
		const out = await cacheFirst({ caches: storage, fetch: fetchImpl, now: () => now }, req(url), name, options);
		expect(await out.text()).toBe('tile-bytes');
		const stored = [...store.get(name)!.values()][0];
		expect(stored.headers.get('x-darkmap-cached-at')).toBe(String(now));
		expect(stored.headers.get('x-darkmap-cache-bytes')).toBe('10');
		expect(await stored.clone().text()).toBe('tile-bytes');
	});

	it('serves a fresh entry without fetching', async () => {
		const { storage } = makeCaches();
		await seed(storage, { 'cache-control': 'public, max-age=60', 'x-darkmap-cached-at': String(now - 30_000) });
		const fetchImpl = vi.fn();
		const out = await cacheFirst({ caches: storage, fetch: fetchImpl, now: () => now }, req(url), name, options);
		expect(await out.text()).toBe('old');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each<Record<string, string>>([
		{ 'cache-control': 'max-age=60', 'x-darkmap-cached-at': String(now - 60_000) },
		{ 'cache-control': 'max-age=60' },
		{ 'cache-control': 'max-age=60', 'x-darkmap-cached-at': 'invalid' },
	])('revalidates expired or unknown write times: %j', async (headers) => {
		const { storage } = makeCaches();
		await seed(storage, headers);
		const fetchImpl = vi.fn().mockResolvedValue(new Response('new', { headers: { 'cache-control': 'max-age=60' } }));
		const out = await cacheFirst({ caches: storage, fetch: fetchImpl, now: () => now }, req(url), name, options);
		expect(await out.text()).toBe('new');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const stored = await (await storage.open(name)).match(req(url));
		expect(stored?.headers.get('x-darkmap-cached-at')).toBe(String(now));
		expect(await stored?.text()).toBe('new');
	});

	it('keeps origin age when a successful refresh arrived already stale', async () => {
		const { storage } = makeCaches();
		const fetchImpl = vi.fn().mockImplementation(
			async () =>
				new Response('old-origin', {
					headers: {
						'cache-control': 'max-age=60',
						date: new Date(now - 120_000).toUTCString(),
					},
				}),
		);
		const deps = { caches: storage, fetch: fetchImpl, now: () => now };
		await cacheFirst(deps, req(url), name, options);
		await cacheFirst(deps, req(url), name, options);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('serves a successful no-store refresh without replacing cached offline bytes', async () => {
		const { storage } = makeCaches();
		await seed(storage);
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response('private-current', { headers: { 'cache-control': 'no-store' } }));
		const result = await cacheFirst({ caches: storage, fetch: fetchImpl, now: () => now }, req(url), name, options);
		expect(await result.text()).toBe('private-current');
		expect(await (await (await storage.open(name)).match(req(url)))?.text()).toBe('old');
	});

	it('shares one refresh for normalized concurrent requests and returns independently readable bodies', async () => {
		const { storage } = makeCaches();
		await seed(storage);
		let resolve!: (response: Response) => void;
		const pending = new Promise<Response>((done) => {
			resolve = done;
		});
		const fetchImpl = vi.fn().mockReturnValue(pending);
		const deps = { caches: storage, fetch: fetchImpl, now: () => now };
		const first = cacheFirst(deps, req(url), name, options);
		const second = cacheFirst(deps, req('/api/raster?z=2&x=1'), name, options);
		resolve(new Response('new', { headers: { 'cache-control': 'max-age=60' } }));
		const results = await Promise.all([first, second]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(await Promise.all(results.map((response) => response.text()))).toEqual(['new', 'new']);
	});

	it('does not share refreshes between cache buckets', async () => {
		const { storage } = makeCaches();
		const fetchImpl = vi.fn().mockImplementation(async () => new Response('new'));
		const deps = { caches: storage, fetch: fetchImpl, now: () => now };
		await Promise.all([
			cacheFirst(deps, req(url), name, options),
			cacheFirst(deps, req(url), 'darkmap-atmospheric-tile', options),
		]);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('returns stale bytes when offline without inventing a write time', async () => {
		const { storage } = makeCaches();
		await seed(storage);
		const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
		const out = await cacheFirst({ caches: storage, fetch: fetchImpl, now: () => now }, req(url), name, options);
		expect(await out.text()).toBe('old');
		expect((await (await storage.open(name)).match(req(url)))?.headers.get('x-darkmap-cached-at')).toBeNull();
	});

	it.each([401, 403, 502])('retains stale bytes after HTTP %s', async (status) => {
		const { storage } = makeCaches();
		await seed(storage);
		const fetchImpl = vi.fn().mockResolvedValue(new Response('error', { status }));
		await cacheFirst({ caches: storage, fetch: fetchImpl, now: () => now }, req(url), name, options);
		expect(await (await (await storage.open(name)).match(req(url)))?.text()).toBe('old');
	});

	it('never stores opaque redirects', async () => {
		const { storage } = makeCaches();
		await seed(storage);
		const redirected = new Response('redirect');
		Object.defineProperty(redirected, 'type', { value: 'opaqueredirect' });
		await cacheFirst(
			{ caches: storage, fetch: vi.fn().mockResolvedValue(redirected), now: () => now },
			req(url),
			name,
			options,
		);
		expect(await (await (await storage.open(name)).match(req(url)))?.text()).toBe('old');
	});

	it('serves the network response when metadata storage exceeds quota', async () => {
		const storage: CacheStorageLike = {
			open: async () => ({
				match: async () => undefined,
				put: async () => {
					throw new Error('quota');
				},
			}),
		};
		const out = await cacheFirst(
			{ caches: storage, fetch: vi.fn().mockResolvedValue(new Response('new')), now: () => now },
			req(url),
			name,
			options,
		);
		expect(await out.text()).toBe('new');
	});

	it('keeps default app-shell cache-first behavior for entries without timestamps', async () => {
		const { storage } = makeCaches();
		await seed(storage, {}, 'darkmap-app-shell-v1');
		const fetchImpl = vi.fn();
		const out = await cacheFirst({ caches: storage, fetch: fetchImpl }, req(url), 'darkmap-app-shell-v1');
		expect(await out.text()).toBe('old');
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
