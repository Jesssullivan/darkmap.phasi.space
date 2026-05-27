import { Context, Data, Effect, Layer } from 'effect';

/**
 * OfflineCacheService — typed lifecycle around an app-shell service worker
 * cache and a bounded raster-tile cache for field use (GH #100).
 *
 * Scope of this module is **interface + metadata model only**. The SW
 * registration adapter (calling `navigator.serviceWorker.register`, wiring
 * MapLibre to a Cache Storage backend) lands in a follow-on PR alongside the
 * PWA manifest changes. Keeping that boundary lets the lifecycle states and
 * eviction policy land under unit-test cover before any UI/SW code ships.
 *
 * Integration sketch for callers:
 *   const status = await Effect.runPromise(
 *     Effect.gen(function* () {
 *       const cache = yield* OfflineCacheService;
 *       yield* cache.register();
 *       return yield* cache.status();
 *     }).pipe(Effect.provide(OfflineCacheServiceFake)),
 *   );
 */

/** App-shell + bounded layer cache status snapshot. */
export interface OfflineCacheStatus {
	readonly registered: boolean;
	readonly appShellBytes: number;
	readonly layerBytes: number;
	readonly entries: number;
	/** Wall-clock of the most recent successful prefetch/write, if any. */
	readonly lastUpdated?: string;
}

export interface CacheEntryMeta {
	readonly key: string;
	readonly bytes: number;
	readonly storedAt: string;
	/** Logical bucket so eviction can drain a single layer or basemap. */
	readonly bucket: 'app-shell' | 'raster-tile' | 'route' | 'ephemeris' | 'static-projection';
}

export interface EvictionRequest {
	readonly bucket?: CacheEntryMeta['bucket'];
	/** Keep total under this many bytes across the targeted bucket(s). */
	readonly targetBytes?: number;
}

export interface EvictionResult {
	readonly evicted: number;
	readonly freedBytes: number;
}

export type OfflineCacheReason = 'unsupported' | 'registration-failed' | 'storage-quota' | 'not-registered';

export class OfflineCacheError extends Data.TaggedError('OfflineCacheError')<{
	readonly reason: OfflineCacheReason;
	readonly detail?: string;
}> {}

export class OfflineCacheService extends Context.Tag('@darkmap/OfflineCacheService')<
	OfflineCacheService,
	{
		readonly register: () => Effect.Effect<void, OfflineCacheError>;
		readonly unregister: () => Effect.Effect<void, OfflineCacheError>;
		readonly status: () => Effect.Effect<OfflineCacheStatus, OfflineCacheError>;
		readonly evict: (req: EvictionRequest) => Effect.Effect<EvictionResult, OfflineCacheError>;
	}
>() {}

/**
 * Minimal adapter shape the live Layer expects. The real Live impl (next PR)
 * binds these to `navigator.serviceWorker`, `caches`, and `navigator.storage`.
 * Tests pass a fake.
 */
export interface OfflineCacheAdapter {
	readonly isSupported: () => boolean;
	readonly register: () => Promise<void>;
	readonly unregister: () => Promise<void>;
	readonly snapshot: () => Promise<{ registered: boolean; entries: readonly CacheEntryMeta[]; lastUpdated?: string }>;
	readonly drop: (key: string) => Promise<number>;
}

/**
 * Default eviction target. Raster tiles dominate the layer cache budget;
 * the app shell + ephemeris payloads are small enough that targeting the
 * raster bucket first frees the most without touching navigation assets.
 */
export const OFFLINE_CACHE_DEFAULT_TARGET_BYTES = 32 * 1024 * 1024;

export const makeOfflineCacheServiceLive = (adapter: OfflineCacheAdapter): Layer.Layer<OfflineCacheService> =>
	Layer.succeed(
		OfflineCacheService,
		OfflineCacheService.of({
			register: () =>
				Effect.gen(function* () {
					if (!adapter.isSupported()) {
						return yield* Effect.fail(new OfflineCacheError({ reason: 'unsupported' }));
					}
					yield* Effect.tryPromise({
						try: () => adapter.register(),
						catch: (cause) =>
							new OfflineCacheError({
								reason: 'registration-failed',
								detail: (cause as Error)?.message ?? String(cause),
							}),
					});
				}),

			unregister: () =>
				Effect.tryPromise({
					try: () => adapter.unregister(),
					catch: (cause) =>
						new OfflineCacheError({
							reason: 'registration-failed',
							detail: (cause as Error)?.message ?? String(cause),
						}),
				}),

			status: () =>
				Effect.gen(function* () {
					const snap = yield* Effect.tryPromise({
						try: () => adapter.snapshot(),
						catch: (cause) =>
							new OfflineCacheError({
								reason: 'not-registered',
								detail: (cause as Error)?.message ?? String(cause),
							}),
					});
					let appShellBytes = 0;
					let layerBytes = 0;
					for (const entry of snap.entries) {
						if (entry.bucket === 'app-shell') appShellBytes += entry.bytes;
						else layerBytes += entry.bytes;
					}
					return {
						registered: snap.registered,
						appShellBytes,
						layerBytes,
						entries: snap.entries.length,
						lastUpdated: snap.lastUpdated,
					} satisfies OfflineCacheStatus;
				}),

			evict: (req) =>
				Effect.gen(function* () {
					const snap = yield* Effect.tryPromise({
						try: () => adapter.snapshot(),
						catch: (cause) =>
							new OfflineCacheError({
								reason: 'not-registered',
								detail: (cause as Error)?.message ?? String(cause),
							}),
					});
					return yield* applyEviction(adapter, snap.entries, req);
				}),
		}),
	);

/**
 * Eviction policy: oldest-first within the targeted bucket(s) until the
 * remaining bucket footprint is under `targetBytes`. Returns counts so the
 * UI layer can render "freed N MiB" without re-querying the cache.
 */
const applyEviction = (
	adapter: OfflineCacheAdapter,
	entries: readonly CacheEntryMeta[],
	req: EvictionRequest,
): Effect.Effect<EvictionResult, OfflineCacheError> =>
	Effect.gen(function* () {
		const target = req.targetBytes ?? OFFLINE_CACHE_DEFAULT_TARGET_BYTES;
		const inScope = req.bucket ? entries.filter((e) => e.bucket === req.bucket) : entries.slice();
		const oldestFirst = inScope.slice().sort((a, b) => a.storedAt.localeCompare(b.storedAt));
		let total = oldestFirst.reduce((sum, e) => sum + e.bytes, 0);
		let evicted = 0;
		let freed = 0;
		for (const entry of oldestFirst) {
			if (total <= target) break;
			const dropped = yield* Effect.tryPromise({
				try: () => adapter.drop(entry.key),
				catch: (cause) =>
					new OfflineCacheError({
						reason: 'storage-quota',
						detail: (cause as Error)?.message ?? String(cause),
					}),
			});
			total -= dropped;
			freed += dropped;
			evicted += 1;
		}
		return { evicted, freedBytes: freed };
	});

/**
 * Test/preview layer with a caller-supplied adapter. Avoids importing the
 * browser-only Live wiring inside Vitest, and lets UI work stub a fully
 * populated cache for visual states.
 */
export const makeOfflineCacheServiceFake = makeOfflineCacheServiceLive;
