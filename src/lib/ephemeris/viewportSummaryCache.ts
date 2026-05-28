import type { EphemerisReadout, LatLon } from './EphemerisClient';
import { summarizeEventRanges, type EphemerisViewportSummaryRequest, type EventRangeMap } from './viewportSummary';

type Client = (loc: LatLon, t: Date) => Promise<EphemerisReadout>;

const RANGE_CACHE_MAX = 64;
const rangeCache = new Map<string, Promise<EventRangeMap>>();

const cachePromise = (key: string, promise: Promise<EventRangeMap>): Promise<EventRangeMap> => {
	if (rangeCache.has(key)) rangeCache.delete(key);
	rangeCache.set(key, promise);
	while (rangeCache.size > RANGE_CACHE_MAX) {
		const oldest = rangeCache.keys().next().value;
		if (oldest === undefined) break;
		rangeCache.delete(oldest);
	}
	promise.catch(() => {
		if (rangeCache.get(key) === promise) rangeCache.delete(key);
	});
	return promise;
};

export const clearViewportRangeCache = (): void => {
	rangeCache.clear();
};

export const viewportRangesFor = (
	req: EphemerisViewportSummaryRequest,
	client: Client,
	time: Date,
): Promise<EventRangeMap> => {
	const hit = rangeCache.get(req.key);
	if (hit) {
		rangeCache.delete(req.key);
		rangeCache.set(req.key, hit);
		return hit;
	}
	return cachePromise(
		req.key,
		Promise.all(req.samplePoints.map((p) => client(p, time))).then((readouts) => summarizeEventRanges(readouts)),
	);
};
