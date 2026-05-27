import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	makeOfflineCacheServiceLive,
	OFFLINE_CACHE_DEFAULT_TARGET_BYTES,
	OfflineCacheService,
	type CacheEntryMeta,
	type OfflineCacheAdapter,
} from './OfflineCacheService';

const makeAdapter = (overrides: Partial<OfflineCacheAdapter> & { entries?: CacheEntryMeta[] } = {}) => {
	const calls: string[] = [];
	const dropped: string[] = [];
	let entries: CacheEntryMeta[] = overrides.entries ?? [];
	const adapter: OfflineCacheAdapter = {
		isSupported: overrides.isSupported ?? (() => true),
		register: overrides.register ?? (async () => void calls.push('register')),
		unregister: overrides.unregister ?? (async () => void calls.push('unregister')),
		snapshot:
			overrides.snapshot ??
			(async () => ({
				registered: calls.includes('register'),
				entries,
				lastUpdated: '2026-05-27T12:00:00Z',
			})),
		drop:
			overrides.drop ??
			(async (key) => {
				const e = entries.find((x) => x.key === key);
				if (!e) return 0;
				dropped.push(key);
				entries = entries.filter((x) => x.key !== key);
				return e.bytes;
			}),
	};
	return { adapter, calls, dropped, getEntries: () => entries };
};

const runEffect = <A, E>(
	eff: Effect.Effect<A, E, OfflineCacheService>,
	layer: ReturnType<typeof makeOfflineCacheServiceLive>,
) => Effect.runPromiseExit(eff.pipe(Effect.provide(layer)));

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

describe('OfflineCacheService.register', () => {
	it('refuses to register when the platform reports unsupported', async () => {
		const { adapter } = makeAdapter({ isSupported: () => false });
		const layer = makeOfflineCacheServiceLive(adapter);
		const exit = await runEffect(
			Effect.gen(function* () {
				const svc = yield* OfflineCacheService;
				return yield* svc.register();
			}),
			layer,
		);
		expect(expectFailReason(exit)).toBe('unsupported');
	});

	it('propagates registration failures as registration-failed', async () => {
		const { adapter } = makeAdapter({
			register: async () => {
				throw new Error('SW boot blocked');
			},
		});
		const layer = makeOfflineCacheServiceLive(adapter);
		const exit = await runEffect(
			Effect.gen(function* () {
				const svc = yield* OfflineCacheService;
				return yield* svc.register();
			}),
			layer,
		);
		expect(expectFailReason(exit)).toBe('registration-failed');
	});

	it('succeeds on a supported platform', async () => {
		const { adapter, calls } = makeAdapter();
		const layer = makeOfflineCacheServiceLive(adapter);
		const exit = await runEffect(
			Effect.gen(function* () {
				const svc = yield* OfflineCacheService;
				yield* svc.register();
				return yield* svc.status();
			}),
			layer,
		);
		const status = expectSuccess(exit);
		expect(calls).toContain('register');
		expect(status.registered).toBe(true);
		expect(status.entries).toBe(0);
		expect(status.appShellBytes).toBe(0);
		expect(status.layerBytes).toBe(0);
	});
});

describe('OfflineCacheService.status', () => {
	it('splits app-shell vs layer bytes from the adapter snapshot', async () => {
		const entries: CacheEntryMeta[] = [
			{ key: 'shell:index.html', bytes: 12_000, storedAt: '2026-05-27T11:50:00Z', bucket: 'app-shell' },
			{ key: 'shell:app.js', bytes: 200_000, storedAt: '2026-05-27T11:50:01Z', bucket: 'app-shell' },
			{ key: 'tile:viirs/9/137/197', bytes: 64_000, storedAt: '2026-05-27T11:55:00Z', bucket: 'raster-tile' },
			{ key: 'tile:viirs/9/138/197', bytes: 64_000, storedAt: '2026-05-27T11:55:01Z', bucket: 'raster-tile' },
		];
		const { adapter } = makeAdapter({ entries });
		const layer = makeOfflineCacheServiceLive(adapter);
		const exit = await runEffect(
			Effect.gen(function* () {
				const svc = yield* OfflineCacheService;
				yield* svc.register();
				return yield* svc.status();
			}),
			layer,
		);
		const status = expectSuccess(exit);
		expect(status.entries).toBe(4);
		expect(status.appShellBytes).toBe(212_000);
		expect(status.layerBytes).toBe(128_000);
		expect(status.lastUpdated).toBe('2026-05-27T12:00:00Z');
	});
});

describe('OfflineCacheService.evict', () => {
	it('evicts oldest-first until under targetBytes (bucket-scoped)', async () => {
		const entries: CacheEntryMeta[] = [
			{ key: 'tile:a', bytes: 64_000, storedAt: '2026-05-27T11:00:00Z', bucket: 'raster-tile' },
			{ key: 'tile:b', bytes: 64_000, storedAt: '2026-05-27T11:30:00Z', bucket: 'raster-tile' },
			{ key: 'tile:c', bytes: 64_000, storedAt: '2026-05-27T12:00:00Z', bucket: 'raster-tile' },
			{ key: 'shell:app.js', bytes: 200_000, storedAt: '2026-05-27T10:00:00Z', bucket: 'app-shell' },
		];
		const { adapter, dropped } = makeAdapter({ entries });
		const layer = makeOfflineCacheServiceLive(adapter);
		const exit = await runEffect(
			Effect.gen(function* () {
				const svc = yield* OfflineCacheService;
				return yield* svc.evict({ bucket: 'raster-tile', targetBytes: 100_000 });
			}),
			layer,
		);
		const result = expectSuccess(exit);
		expect(result.evicted).toBe(2);
		expect(result.freedBytes).toBe(128_000);
		expect(dropped).toEqual(['tile:a', 'tile:b']);
	});

	it('returns zero-eviction when already under target', async () => {
		const entries: CacheEntryMeta[] = [
			{ key: 'tile:a', bytes: 16_000, storedAt: '2026-05-27T11:00:00Z', bucket: 'raster-tile' },
		];
		const { adapter } = makeAdapter({ entries });
		const layer = makeOfflineCacheServiceLive(adapter);
		const exit = await runEffect(
			Effect.gen(function* () {
				const svc = yield* OfflineCacheService;
				return yield* svc.evict({ targetBytes: 32_000 });
			}),
			layer,
		);
		const result = expectSuccess(exit);
		expect(result.evicted).toBe(0);
		expect(result.freedBytes).toBe(0);
	});

	it('falls back to OFFLINE_CACHE_DEFAULT_TARGET_BYTES when targetBytes is omitted', async () => {
		// Build entries that exceed the default target so omission triggers eviction.
		const big = OFFLINE_CACHE_DEFAULT_TARGET_BYTES;
		const entries: CacheEntryMeta[] = [
			{ key: 'tile:old', bytes: big, storedAt: '2026-05-26T00:00:00Z', bucket: 'raster-tile' },
			{ key: 'tile:new', bytes: 1_000_000, storedAt: '2026-05-27T00:00:00Z', bucket: 'raster-tile' },
		];
		const { adapter, dropped } = makeAdapter({ entries });
		const layer = makeOfflineCacheServiceLive(adapter);
		const exit = await runEffect(
			Effect.gen(function* () {
				const svc = yield* OfflineCacheService;
				return yield* svc.evict({ bucket: 'raster-tile' });
			}),
			layer,
		);
		const result = expectSuccess(exit);
		expect(result.evicted).toBe(1);
		expect(dropped).toEqual(['tile:old']);
	});

	it('surfaces drop errors as storage-quota', async () => {
		const entries: CacheEntryMeta[] = [
			{ key: 'tile:a', bytes: 1_000_000, storedAt: '2026-05-27T11:00:00Z', bucket: 'raster-tile' },
		];
		const { adapter } = makeAdapter({
			entries,
			drop: async () => {
				throw new Error('disk quota exceeded');
			},
		});
		const layer = makeOfflineCacheServiceLive(adapter);
		const exit = await runEffect(
			Effect.gen(function* () {
				const svc = yield* OfflineCacheService;
				return yield* svc.evict({ targetBytes: 0 });
			}),
			layer,
		);
		expect(expectFailReason(exit)).toBe('storage-quota');
	});
});
