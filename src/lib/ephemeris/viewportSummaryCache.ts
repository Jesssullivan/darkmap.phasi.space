import type { EphemerisReadout, LatLon } from './EphemerisClient';
import { summarizeEventRanges, type EphemerisViewportSummaryRequest, type EventRangeMap } from './viewportSummary';

type Client = (loc: LatLon, t: Date) => Promise<EphemerisReadout>;

export type ViewportRangeSummarySource = 'computed' | 'in-flight-cache' | 'memory-cache';

interface CachedViewportRangeSummary {
	readonly computedAtMs: number;
	readonly key: string;
	readonly ranges: EventRangeMap;
}

export interface ViewportRangeSummary extends CachedViewportRangeSummary {
	readonly source: ViewportRangeSummarySource;
}

interface RangeCacheEntry {
	promise: Promise<CachedViewportRangeSummary>;
	value?: CachedViewportRangeSummary;
}

const RANGE_CACHE_MAX = 64;
const rangeCache = new Map<string, RangeCacheEntry>();

const withSource = (summary: CachedViewportRangeSummary, source: ViewportRangeSummarySource): ViewportRangeSummary => ({
	...summary,
	source,
});

const cacheEntry = (key: string, entry: RangeCacheEntry): RangeCacheEntry => {
	if (rangeCache.has(key)) rangeCache.delete(key);
	rangeCache.set(key, entry);
	while (rangeCache.size > RANGE_CACHE_MAX) {
		const oldest = rangeCache.keys().next().value;
		if (oldest === undefined) break;
		rangeCache.delete(oldest);
	}
	entry.promise
		.then((value) => {
			if (rangeCache.get(key) === entry) entry.value = value;
		})
		.catch(() => {
			if (rangeCache.get(key) === entry) rangeCache.delete(key);
		});
	return entry;
};

const makeEntry = (req: EphemerisViewportSummaryRequest, client: Client, time: Date): RangeCacheEntry => ({
	promise: Promise.all(req.samplePoints.map((p) => client(p, time))).then((readouts) => {
		return {
			computedAtMs: Date.now(),
			key: req.key,
			ranges: summarizeEventRanges(readouts),
		};
	}),
});

const touchEntry = (key: string, entry: RangeCacheEntry): void => {
	rangeCache.delete(key);
	rangeCache.set(key, entry);
};

export const clearViewportRangeCache = (): void => {
	rangeCache.clear();
};

export const viewportRangesFor = (
	req: EphemerisViewportSummaryRequest,
	client: Client,
	time: Date,
): Promise<ViewportRangeSummary> => {
	const hit = rangeCache.get(req.key);
	if (hit) {
		const source: ViewportRangeSummarySource = hit.value ? 'memory-cache' : 'in-flight-cache';
		touchEntry(req.key, hit);
		return hit.promise.then((summary) => withSource(summary, source));
	}

	const entry = cacheEntry(req.key, makeEntry(req, client, time));
	return entry.promise.then((summary) => withSource(summary, 'computed'));
};
