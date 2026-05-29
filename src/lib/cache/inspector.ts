/**
 * Pure helper that turns an `OfflineCacheService` snapshot into the rows
 * the cache-inspector UI renders (#234, child of #195).
 *
 * Kept out of the Svelte component so the row derivation is
 * unit-testable and stays aligned with the `BucketPolicy` table that
 * drives runtime eviction. Anything you change here is something the
 * `/cache` page renders identically.
 */

import {
	DEFAULT_BROWSER_CACHE_POLICY,
	policyByEvictionOrder,
	type BucketPolicy,
} from '$lib/effect/services/CachePolicy';
import type { CacheEntryMeta } from '$lib/effect/services/OfflineCacheService';

export type CacheBucket = CacheEntryMeta['bucket'];

export interface InspectorRow {
	readonly bucket: CacheBucket;
	readonly label: string;
	readonly description: string;
	readonly bytesUsed: number;
	readonly entryCount: number;
	/** Soft target from the policy; `undefined` when unmanaged (app-shell). */
	readonly targetBytes: number | undefined;
	/** 0..1 share of target. `undefined` when no target. Capped at 2 so the bar can show overflow without going off-chart. */
	readonly fractionOfTarget: number | undefined;
	/** False for `app-shell` — its lifecycle is owned by the SW upgrade flow. */
	readonly canClear: boolean;
}

const HUMAN_LABEL: Record<CacheBucket, string> = {
	'app-shell': 'App shell',
	'raster-tile': 'Raster tiles',
	'atmospheric-tile': 'Atmospheric tiles',
	ephemeris: 'Ephemeris',
	'static-projection': 'Static projection',
	route: 'Routes',
};

const FALLBACK_DESCRIPTION: Record<CacheBucket, string> = {
	'app-shell': 'PWA shell — managed by the service-worker upgrade lifecycle.',
	'raster-tile': 'VIIRS DNB + Falchi World Atlas raster tiles.',
	'atmospheric-tile': 'NASA GIBS WMTS + Open-Meteo + OpenAQ atmospheric responses.',
	ephemeris: 'Point readouts (featureinfo, elevation, twilight).',
	'static-projection': 'Static projection JSON checked into the build.',
	route: 'User-imported GPX / KML routes.',
};

const bytesByBucket = (entries: readonly CacheEntryMeta[]): Map<CacheBucket, { bytes: number; count: number }> => {
	const out = new Map<CacheBucket, { bytes: number; count: number }>();
	for (const e of entries) {
		const prior = out.get(e.bucket) ?? { bytes: 0, count: 0 };
		out.set(e.bucket, { bytes: prior.bytes + e.bytes, count: prior.count + 1 });
	}
	return out;
};

/**
 * Build the inspector row list.
 *
 * Order: policy eviction priority first (so the buckets that drain first
 * under pressure appear at the top), with any orphaned buckets — entries
 * with a bucket that has no policy row — appended at the end.
 *
 * Every bucket in the policy gets a row, even if there are zero entries
 * (gives the user a "nothing cached yet" state without an empty list).
 */
export const buildInspectorRows = (
	snapshot: { readonly entries: readonly CacheEntryMeta[] },
	policy: ReadonlyArray<BucketPolicy> = DEFAULT_BROWSER_CACHE_POLICY,
): readonly InspectorRow[] => {
	const tallies = bytesByBucket(snapshot.entries);
	const out: InspectorRow[] = [];
	const seen = new Set<CacheBucket>();

	for (const row of policyByEvictionOrder(policy)) {
		const tally = tallies.get(row.bucket) ?? { bytes: 0, count: 0 };
		const fraction =
			row.targetBytes === undefined || row.targetBytes <= 0 ? undefined : Math.min(2, tally.bytes / row.targetBytes);
		out.push({
			bucket: row.bucket,
			label: HUMAN_LABEL[row.bucket] ?? row.bucket,
			description: row.description ?? FALLBACK_DESCRIPTION[row.bucket] ?? '',
			bytesUsed: tally.bytes,
			entryCount: tally.count,
			targetBytes: row.targetBytes,
			fractionOfTarget: fraction,
			canClear: row.bucket !== 'app-shell',
		});
		seen.add(row.bucket);
	}

	// Append orphan buckets (entries with a bucket the policy doesn't mention).
	for (const [bucket, tally] of tallies) {
		if (seen.has(bucket)) continue;
		out.push({
			bucket,
			label: HUMAN_LABEL[bucket] ?? bucket,
			description: FALLBACK_DESCRIPTION[bucket] ?? '',
			bytesUsed: tally.bytes,
			entryCount: tally.count,
			targetBytes: undefined,
			fractionOfTarget: undefined,
			canClear: bucket !== 'app-shell',
		});
	}

	return out;
};

export interface InspectorTotals {
	/** Sum of every entry's bytes across every bucket. */
	readonly totalBytesUsed: number;
	/** Sum of `targetBytes` across managed buckets (app-shell has no target). */
	readonly totalTargetBytes: number;
	readonly totalEntries: number;
}

export const buildInspectorTotals = (rows: readonly InspectorRow[]): InspectorTotals => {
	let totalBytesUsed = 0;
	let totalTargetBytes = 0;
	let totalEntries = 0;
	for (const r of rows) {
		totalBytesUsed += r.bytesUsed;
		totalTargetBytes += r.targetBytes ?? 0;
		totalEntries += r.entryCount;
	}
	return { totalBytesUsed, totalTargetBytes, totalEntries };
};

/** Render bytes as "12.4 MiB" / "812 KiB" / "0 B" — UI helper, kept here for testability. */
export const formatBytes = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`;
	const KiB = 1024;
	const MiB = 1024 * 1024;
	const GiB = 1024 * 1024 * 1024;
	if (bytes < MiB) return `${(bytes / KiB).toFixed(1)} KiB`;
	if (bytes < GiB) return `${(bytes / MiB).toFixed(1)} MiB`;
	return `${(bytes / GiB).toFixed(2)} GiB`;
};
