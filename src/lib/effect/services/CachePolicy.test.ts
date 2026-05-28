import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_BROWSER_CACHE_POLICY,
	enforceCachePolicy,
	policyByEvictionOrder,
	policyForBucket,
	totalPolicyBudgetBytes,
	type BucketPolicy,
	type CacheBucket,
} from './CachePolicy';
import { makeOfflineCacheServiceLive, type CacheEntryMeta, type OfflineCacheAdapter } from './OfflineCacheService';

/* ----------------------------- fake adapter ----------------------------- */

const makeFakeAdapter = (
	entries: ReadonlyArray<CacheEntryMeta>,
): { adapter: OfflineCacheAdapter; dropped: string[] } => {
	const state = new Map(entries.map((e) => [e.key, e]));
	const dropped: string[] = [];
	const adapter: OfflineCacheAdapter = {
		isSupported: () => true,
		register: async () => {},
		unregister: async () => {},
		snapshot: async () => ({ registered: true, entries: [...state.values()], lastUpdated: '2026-05-28T00:00:00Z' }),
		drop: async (key) => {
			const e = state.get(key);
			if (!e) return 0;
			state.delete(key);
			dropped.push(key);
			return e.bytes;
		},
	};
	return { adapter, dropped };
};

const entry = (bucket: CacheBucket, key: string, bytes: number, storedAt: string): CacheEntryMeta => ({
	bucket,
	key,
	bytes,
	storedAt,
});

/* ------------------------------- policy ------------------------------- */

describe('DEFAULT_BROWSER_CACHE_POLICY', () => {
	it('has a row for every CacheEntryMeta bucket', () => {
		const buckets = DEFAULT_BROWSER_CACHE_POLICY.map((r) => r.bucket).sort();
		expect(buckets).toEqual(
			['app-shell', 'atmospheric-tile', 'ephemeris', 'raster-tile', 'route', 'static-projection'].sort(),
		);
	});

	it('app-shell is unmanaged (targetBytes undefined, priority 99)', () => {
		const row = policyForBucket('app-shell');
		expect(row).toBeDefined();
		expect(row!.targetBytes).toBeUndefined();
		expect(row!.priority).toBe(99);
	});

	it('raster + atmospheric carry the largest budgets', () => {
		const raster = policyForBucket('raster-tile')!;
		const atm = policyForBucket('atmospheric-tile')!;
		const ephem = policyForBucket('ephemeris')!;
		expect(raster.targetBytes!).toBeGreaterThan(ephem.targetBytes!);
		expect(atm.targetBytes!).toBeGreaterThan(ephem.targetBytes!);
	});

	it('totalPolicyBudgetBytes sums the bounded buckets', () => {
		const total = totalPolicyBudgetBytes();
		// 12 + 8 + 4 + 2 + 2 = 28 MiB; should fit under the 32 MiB SW default.
		expect(total).toBe(28 * 1024 * 1024);
	});
});

describe('policyByEvictionOrder', () => {
	it('evicts raster + atmospheric first (priority 1)', () => {
		const order = policyByEvictionOrder().map((b) => b.bucket);
		expect(order[0]).toMatch(/raster-tile|atmospheric-tile/);
		expect(order[1]).toMatch(/raster-tile|atmospheric-tile/);
	});

	it('app-shell is last (priority 99)', () => {
		const order = policyByEvictionOrder().map((b) => b.bucket);
		expect(order[order.length - 1]).toBe('app-shell');
	});
});

describe('enforceCachePolicy', () => {
	it('trims each bounded bucket to its target', async () => {
		// Seed raster-tile with three entries totaling 5 MiB; target is 12 MiB
		// (default), so nothing should be evicted from raster yet.
		const MB = 1024 * 1024;
		const entries = [
			entry('raster-tile', 'r1', 2 * MB, '2026-05-25T10:00:00Z'),
			entry('raster-tile', 'r2', 2 * MB, '2026-05-26T10:00:00Z'),
			entry('raster-tile', 'r3', 1 * MB, '2026-05-27T10:00:00Z'),
		];
		const { adapter, dropped } = makeFakeAdapter(entries);
		const exit = await Effect.runPromiseExit(
			enforceCachePolicy().pipe(Effect.provide(makeOfflineCacheServiceLive(adapter))),
		);
		expect(exit._tag).toBe('Success');
		expect(dropped).toEqual([]); // nothing trimmed, under budget
	});

	it('drops oldest entries when a bucket exceeds its budget', async () => {
		const MB = 1024 * 1024;
		// raster-tile budget is 12 MiB; seed 16 MiB across 4 × 4 MiB entries
		// spread over 4 days. Eviction should drop the two oldest first.
		const entries = [
			entry('raster-tile', 'oldest', 4 * MB, '2026-05-20T10:00:00Z'),
			entry('raster-tile', 'old', 4 * MB, '2026-05-21T10:00:00Z'),
			entry('raster-tile', 'newer', 4 * MB, '2026-05-22T10:00:00Z'),
			entry('raster-tile', 'newest', 4 * MB, '2026-05-23T10:00:00Z'),
		];
		const { adapter, dropped } = makeFakeAdapter(entries);
		const exitExit = await Effect.runPromiseExit(
			enforceCachePolicy().pipe(Effect.provide(makeOfflineCacheServiceLive(adapter))),
		);
		expect(exitExit._tag).toBe('Success');
		// 16 MiB → target 12 MiB → must shed at least 4 MiB → 1 entry minimum.
		// Oldest-first means 'oldest' is the first to go.
		expect(dropped[0]).toBe('oldest');
	});

	it('skips the app-shell bucket regardless of bytes', async () => {
		const MB = 1024 * 1024;
		const entries = [entry('app-shell', 'huge-shell', 50 * MB, '2026-05-20T00:00:00Z')];
		const { adapter, dropped } = makeFakeAdapter(entries);
		await Effect.runPromiseExit(enforceCachePolicy().pipe(Effect.provide(makeOfflineCacheServiceLive(adapter))));
		expect(dropped).toEqual([]); // app-shell never enforced
	});

	it('accepts a custom policy override', async () => {
		const MB = 1024 * 1024;
		// Tighten raster-tile to 1 MiB.
		const tightPolicy: ReadonlyArray<BucketPolicy> = [{ bucket: 'raster-tile', targetBytes: 1 * MB, priority: 1 }];
		const entries = [
			entry('raster-tile', 'a', 1 * MB, '2026-05-20T10:00:00Z'),
			entry('raster-tile', 'b', 1 * MB, '2026-05-21T10:00:00Z'),
			entry('raster-tile', 'c', 1 * MB, '2026-05-22T10:00:00Z'),
		];
		const { adapter, dropped } = makeFakeAdapter(entries);
		await Effect.runPromiseExit(
			enforceCachePolicy(tightPolicy).pipe(Effect.provide(makeOfflineCacheServiceLive(adapter))),
		);
		// 3 MiB total → target 1 MiB → at least 2 must drop, oldest first.
		expect(dropped.length).toBeGreaterThanOrEqual(2);
		expect(dropped[0]).toBe('a');
	});
});
