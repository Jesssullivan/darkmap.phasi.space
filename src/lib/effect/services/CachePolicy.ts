import { Effect } from 'effect';
import {
	OfflineCacheService,
	type CacheEntryMeta,
	type EvictionResult,
	type OfflineCacheError,
} from './OfflineCacheService';

/**
 * Per-bucket cache policy (#195). The existing `OfflineCacheService`
 * already supports targeted eviction per bucket; this module adds the
 * **field-ready policy** on top: how much each bucket is allowed to
 * grow before we trim it, and in what order we trim across buckets
 * when overall pressure is high.
 *
 * The policy lives in TypeScript rather than the service worker so
 * the UI can render the same budgets the eviction enforces. Buckets
 * the SW writes but the policy doesn't mention are left alone.
 */

export type CacheBucket = CacheEntryMeta['bucket'];

export interface BucketPolicy {
	readonly bucket: CacheBucket;
	/**
	 * Soft target. Eviction trims the bucket until it's <= this many
	 * bytes. `undefined` opts the bucket out of automatic eviction
	 * (e.g. app-shell — owned by the SW upgrade lifecycle, not by us).
	 */
	readonly targetBytes: number | undefined;
	/**
	 * Eviction priority. Lower number = evict first when overall pressure
	 * is high. Defaults reflect the dataset character:
	 *   - 1 raster/atmospheric tiles: heavy, easy to refetch
	 *   - 2 point overlays: smaller, faster refetch
	 *   - 3 ephemeris: tiny, expensive to recompute (cache longest)
	 *   - 4 route / static-projection: user content / immutable assets
	 *   - 99 app-shell: never auto-evict
	 */
	readonly priority: number;
	/** Optional human-readable description for the cache inspector UI. */
	readonly description?: string;
}

const MB = 1024 * 1024;

/**
 * Default browser cache policy. Total budget across the active buckets is
 * roughly 30 MiB which fits the SW storage quota on mobile Safari + Chrome
 * without prompting for persistent storage.
 *
 *   raster-tile          12 MiB — VIIRS + World Atlas tiles
 *   atmospheric-tile      8 MiB — GIBS WMTS + Open-Meteo point JSON
 *   ephemeris             4 MiB — featureinfo + elevation responses
 *   static-projection     2 MiB — checked-in projection JSON
 *   route                 2 MiB — user-imported routes
 *   app-shell             ∞     — owned by SW upgrade; not policy-evicted
 */
export const DEFAULT_BROWSER_CACHE_POLICY: ReadonlyArray<BucketPolicy> = [
	{
		bucket: 'raster-tile',
		targetBytes: 12 * MB,
		priority: 1,
		description: 'VIIRS DNB + Falchi World Atlas raster tiles',
	},
	{
		bucket: 'atmospheric-tile',
		targetBytes: 8 * MB,
		priority: 1,
		description: 'NASA GIBS WMTS + Open-Meteo + OpenAQ atmospheric responses',
	},
	{
		bucket: 'ephemeris',
		targetBytes: 4 * MB,
		priority: 3,
		description: 'Point readouts (featureinfo, elevation, twilight)',
	},
	{
		bucket: 'static-projection',
		targetBytes: 2 * MB,
		priority: 4,
		description: 'Static projection JSON checked into the build',
	},
	{
		bucket: 'route',
		targetBytes: 2 * MB,
		priority: 4,
		description: 'User-imported GPX / KML routes',
	},
	{
		bucket: 'app-shell',
		targetBytes: undefined,
		priority: 99,
		description: 'PWA app shell (managed by service-worker upgrade lifecycle)',
	},
];

/** Total of all defined targetBytes; useful for the cache inspector summary. */
export const totalPolicyBudgetBytes = (policy: ReadonlyArray<BucketPolicy> = DEFAULT_BROWSER_CACHE_POLICY): number =>
	policy.reduce((acc, b) => acc + (b.targetBytes ?? 0), 0);

/** Look up a single bucket's policy row. Returns undefined for unmanaged buckets. */
export const policyForBucket = (
	bucket: CacheBucket,
	policy: ReadonlyArray<BucketPolicy> = DEFAULT_BROWSER_CACHE_POLICY,
): BucketPolicy | undefined => policy.find((b) => b.bucket === bucket);

/** Sort policy entries by eviction priority, lowest priority first (= evict first). */
export const policyByEvictionOrder = (
	policy: ReadonlyArray<BucketPolicy> = DEFAULT_BROWSER_CACHE_POLICY,
): ReadonlyArray<BucketPolicy> => [...policy].sort((a, b) => a.priority - b.priority);

/**
 * Apply the policy: walk buckets in eviction-priority order, calling the
 * existing per-bucket `evict({ bucket, targetBytes })` for each row that
 * has a numeric target. Buckets with `targetBytes: undefined` are skipped.
 *
 * Returns the aggregate result so the UI / telemetry can report what was
 * freed in a single pass.
 */
export const enforceCachePolicy = (
	policy: ReadonlyArray<BucketPolicy> = DEFAULT_BROWSER_CACHE_POLICY,
): Effect.Effect<EvictionResult, OfflineCacheError, OfflineCacheService> =>
	Effect.gen(function* () {
		const svc = yield* OfflineCacheService;
		let totalEvicted = 0;
		let totalFreed = 0;
		for (const row of policyByEvictionOrder(policy)) {
			if (row.targetBytes === undefined) continue;
			const result = yield* svc.evict({ bucket: row.bucket, targetBytes: row.targetBytes });
			totalEvicted += result.evicted;
			totalFreed += result.freedBytes;
		}
		return { evicted: totalEvicted, freedBytes: totalFreed };
	});
