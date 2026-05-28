import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { OfflineCacheService } from './OfflineCacheService';
import { makeBrowserAdapter, makeOfflineCacheServiceBrowserLayer } from './OfflineCacheServiceBrowser';

/* ------------------ fakes for navigator.serviceWorker + caches ------------------ */

interface FakeRegistration {
	scope: string;
	unregister: () => Promise<boolean>;
}

class FakeServiceWorkerContainer {
	private registrations: FakeRegistration[] = [];
	public registerCalls: { url: string; scope?: string }[] = [];
	public registerImpl: (url: string, opts?: { scope?: string }) => Promise<FakeRegistration>;

	constructor() {
		this.registerImpl = async (url, opts) => {
			this.registerCalls.push({ url, scope: opts?.scope });
			const reg: FakeRegistration = {
				scope: opts?.scope ?? '/',
				unregister: async () => {
					this.registrations = this.registrations.filter((r) => r !== reg);
					return true;
				},
			};
			this.registrations.push(reg);
			return reg;
		};
	}

	async register(url: string, opts?: { scope?: string }) {
		return this.registerImpl(url, opts);
	}

	async getRegistrations() {
		return this.registrations.slice();
	}
}

class FakeCache {
	private store = new Map<string, Response>();

	async keys(): Promise<Request[]> {
		return [...this.store.keys()].map((url) => new Request(url));
	}

	async match(req: Request | string): Promise<Response | undefined> {
		const url = typeof req === 'string' ? req : req.url;
		return this.store.get(url);
	}

	async put(req: Request | string, res: Response): Promise<void> {
		const url = typeof req === 'string' ? req : req.url;
		this.store.set(url, res);
	}

	async delete(req: Request | string): Promise<boolean> {
		const url = typeof req === 'string' ? req : req.url;
		return this.store.delete(url);
	}

	/** Test-only: seed an entry. */
	__seed(url: string, body: { bytes: number }): void {
		const response = new Response(new Uint8Array(0), {
			headers: { 'content-length': String(body.bytes), date: '2026-05-27T18:00:00Z' },
		});
		this.store.set(url, response);
	}

	get size(): number {
		return this.store.size;
	}
}

class FakeCacheStorage {
	private caches = new Map<string, FakeCache>();

	async keys(): Promise<string[]> {
		return [...this.caches.keys()];
	}

	async open(name: string): Promise<FakeCache> {
		let cache = this.caches.get(name);
		if (!cache) {
			cache = new FakeCache();
			this.caches.set(name, cache);
		}
		return cache;
	}

	async delete(name: string): Promise<boolean> {
		return this.caches.delete(name);
	}

	async match(): Promise<Response | undefined> {
		return undefined;
	}

	has(name: string): boolean {
		return this.caches.has(name);
	}
}

const makeDeps = () => {
	const serviceWorker = new FakeServiceWorkerContainer();
	const cacheStorage = new FakeCacheStorage();
	const now = () => '2026-05-27T18:30:00Z';
	return {
		serviceWorker: serviceWorker as unknown as ServiceWorkerContainer,
		caches: cacheStorage as unknown as CacheStorage,
		now,
		__sw: serviceWorker,
		__caches: cacheStorage,
	};
};

const expectSuccess = <A>(exit: Exit.Exit<A, unknown>): A => {
	if (exit._tag !== 'Success') throw new Error(`expected Success, got Failure: ${JSON.stringify(exit)}`);
	return exit.value;
};

const expectFailReason = (exit: Exit.Exit<unknown, unknown>): string => {
	const json = JSON.stringify(exit);
	const match = /"reason":"([^"]+)"/.exec(json);
	if (!match) throw new Error(`no reason in cause: ${json}`);
	return match[1];
};

/* ----------------------------- adapter shape ----------------------------- */

describe('makeBrowserAdapter — isSupported', () => {
	it('reports unsupported when serviceWorker is missing', () => {
		const adapter = makeBrowserAdapter({
			serviceWorker: undefined,
			caches: {} as unknown as CacheStorage,
		});
		expect(adapter.isSupported()).toBe(false);
	});

	it('reports unsupported when CacheStorage is missing', () => {
		const adapter = makeBrowserAdapter({
			serviceWorker: {} as unknown as ServiceWorkerContainer,
			caches: undefined,
		});
		expect(adapter.isSupported()).toBe(false);
	});

	it('reports supported when both are present', () => {
		const deps = makeDeps();
		const adapter = makeBrowserAdapter(deps);
		expect(adapter.isSupported()).toBe(true);
	});
});

describe('makeBrowserAdapter — register/unregister', () => {
	it('registers at the canonical SW URL with scope "/"', async () => {
		const deps = makeDeps();
		const adapter = makeBrowserAdapter(deps);
		await adapter.register();
		expect(deps.__sw.registerCalls).toEqual([{ url: '/service-worker.js', scope: '/' }]);
		expect(await deps.__sw.getRegistrations()).toHaveLength(1);
	});

	it('throws when the serviceWorker container is missing on register', async () => {
		const adapter = makeBrowserAdapter({ serviceWorker: undefined, caches: {} as unknown as CacheStorage });
		await expect(adapter.register()).rejects.toThrow(/unavailable/);
	});

	it('unregisters every registration', async () => {
		const deps = makeDeps();
		const adapter = makeBrowserAdapter(deps);
		await adapter.register();
		await adapter.register();
		expect(await deps.__sw.getRegistrations()).toHaveLength(2);
		await adapter.unregister();
		expect(await deps.__sw.getRegistrations()).toHaveLength(0);
	});

	it('treats unregister with no SW as a no-op', async () => {
		const adapter = makeBrowserAdapter({ serviceWorker: undefined, caches: {} as unknown as CacheStorage });
		await expect(adapter.unregister()).resolves.toBeUndefined();
	});
});

describe('makeBrowserAdapter — snapshot bucket attribution', () => {
	it('maps darkmap-* cache names to bucket taxonomy', async () => {
		const deps = makeDeps();
		const adapter = makeBrowserAdapter(deps);

		const shell = await deps.__caches.open('darkmap-app-shell-v123');
		shell.__seed('https://darkmap.example/_app/immutable/start.js', { bytes: 12_345 });
		const raster = await deps.__caches.open('darkmap-raster-tile');
		raster.__seed('https://darkmap.example/api/raster/viirs/9/137/197', { bytes: 64_000 });
		const atmospheric = await deps.__caches.open('darkmap-atmospheric-tile');
		atmospheric.__seed('https://darkmap.example/api/raster?layer=clouds-modis-terra&kind=atmospheric&z=4&x=5&y=6', {
			bytes: 32_000,
		});
		const ephem = await deps.__caches.open('darkmap-ephemeris');
		ephem.__seed('https://darkmap.example/api/featureinfo?x=1', { bytes: 1_024 });
		const proj = await deps.__caches.open('darkmap-static-projection');
		proj.__seed('https://darkmap.example/projection/pulse.json', { bytes: 8_000 });
		const route = await deps.__caches.open('darkmap-route');
		route.__seed('local:user/route-1.gpx', { bytes: 4_096 });

		const snap = await adapter.snapshot();
		expect(snap.registered).toBe(false); // no register() was called
		const byBucket = new Map(snap.entries.map((e) => [e.bucket, e]));
		expect(byBucket.get('app-shell')?.bytes).toBe(12_345);
		expect(byBucket.get('raster-tile')?.bytes).toBe(64_000);
		expect(byBucket.get('atmospheric-tile')?.bytes).toBe(32_000);
		expect(byBucket.get('ephemeris')?.bytes).toBe(1_024);
		expect(byBucket.get('static-projection')?.bytes).toBe(8_000);
		expect(byBucket.get('route')?.bytes).toBe(4_096);
	});

	it('ignores non-darkmap caches', async () => {
		const deps = makeDeps();
		const adapter = makeBrowserAdapter(deps);
		await deps.__caches.open('some-other-app');
		const darkmap = await deps.__caches.open('darkmap-raster-tile');
		darkmap.__seed('https://darkmap.example/api/raster/a', { bytes: 100 });
		const snap = await adapter.snapshot();
		expect(snap.entries).toHaveLength(1);
		expect(snap.entries[0].bucket).toBe('raster-tile');
	});

	it('reports registered=true when a registration exists', async () => {
		const deps = makeDeps();
		const adapter = makeBrowserAdapter(deps);
		await adapter.register();
		const snap = await adapter.snapshot();
		expect(snap.registered).toBe(true);
	});

	it('returns empty when CacheStorage is missing', async () => {
		const adapter = makeBrowserAdapter({
			serviceWorker: new FakeServiceWorkerContainer() as unknown as ServiceWorkerContainer,
			caches: undefined,
		});
		const snap = await adapter.snapshot();
		expect(snap).toEqual({ registered: false, entries: [] });
	});
});

describe('makeBrowserAdapter — drop', () => {
	it('routes a composite key back to the right cache and reports bytes', async () => {
		const deps = makeDeps();
		const adapter = makeBrowserAdapter(deps);
		const raster = await deps.__caches.open('darkmap-raster-tile');
		raster.__seed('https://darkmap.example/api/raster/a', { bytes: 64_000 });
		raster.__seed('https://darkmap.example/api/raster/b', { bytes: 32_000 });
		const snap = await adapter.snapshot();
		const target = snap.entries.find((e) => e.key.endsWith('/api/raster/a'))!;
		const freed = await adapter.drop(target.key);
		expect(freed).toBe(64_000);
		expect(raster.size).toBe(1);
	});

	it('returns 0 for an unknown key', async () => {
		const deps = makeDeps();
		const adapter = makeBrowserAdapter(deps);
		expect(await adapter.drop('darkmap-raster-tile|https://example/missing')).toBe(0);
	});

	it('returns 0 when the key does not contain a separator', async () => {
		const deps = makeDeps();
		const adapter = makeBrowserAdapter(deps);
		expect(await adapter.drop('not-a-composite-key')).toBe(0);
	});
});

/* ----------------------- end-to-end via the Service ---------------------- */

describe('OfflineCacheServiceBrowser Layer end-to-end', () => {
	it('register → status reports correct aggregation, evict trims oldest first', async () => {
		const deps = makeDeps();
		// Pre-seed two raster entries via FakeCache.__seed; the public API only
		// reads them on snapshot, so the date header drives "oldest" ordering.
		const raster = await deps.__caches.open('darkmap-raster-tile');
		const old = new Response(new Uint8Array(0), {
			headers: { 'content-length': '64000', date: '2026-05-27T10:00:00Z' },
		});
		const newish = new Response(new Uint8Array(0), {
			headers: { 'content-length': '64000', date: '2026-05-27T17:00:00Z' },
		});
		await raster.put('https://darkmap.example/api/raster/old', old);
		await raster.put('https://darkmap.example/api/raster/new', newish);

		const layer = makeOfflineCacheServiceBrowserLayer(deps);

		const statusExit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* OfflineCacheService;
				yield* svc.register();
				return yield* svc.status();
			}).pipe(Effect.provide(layer)),
		);
		const status = expectSuccess(statusExit);
		expect(status.registered).toBe(true);
		expect(status.layerBytes).toBe(128_000);
		expect(status.entries).toBe(2);

		const evictExit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* OfflineCacheService;
				return yield* svc.evict({ bucket: 'raster-tile', targetBytes: 100_000 });
			}).pipe(Effect.provide(layer)),
		);
		const evicted = expectSuccess(evictExit);
		expect(evicted.evicted).toBe(1);
		expect(evicted.freedBytes).toBe(64_000);
		// The remaining entry should be the newer one.
		const remaining = await raster.keys();
		expect(remaining[0].url).toContain('/api/raster/new');
	});

	it('surfaces register failures when the SW container is missing', async () => {
		const layer = makeOfflineCacheServiceBrowserLayer({
			serviceWorker: undefined,
			caches: new FakeCacheStorage() as unknown as CacheStorage,
		});
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* OfflineCacheService;
				return yield* svc.register();
			}).pipe(Effect.provide(layer)),
		);
		expect(expectFailReason(exit)).toBe('unsupported');
	});
});
