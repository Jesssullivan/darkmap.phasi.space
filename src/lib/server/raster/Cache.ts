import { Context, Effect, Layer, Option } from 'effect';
import type { RasterQuery, RasterResponse } from './RasterClient';

export class RasterCache extends Context.Tag('@darkmap/RasterCache')<
	RasterCache,
	{
		readonly get: (q: RasterQuery) => Effect.Effect<Option.Option<RasterResponse>>;
		readonly set: (q: RasterQuery, v: RasterResponse) => Effect.Effect<void>;
	}
>() {}

const cacheKey = (q: RasterQuery): string => `${q.layer}::${q.qt}::${q.qd}`;

const DEFAULT_MAX_ENTRIES = 256;

/**
 * In-process LRU. Keyed on `(layer, qt, qd)`. Phase 2 swap target:
 * replace with a Layer that talks to rustfs S3, same Tag, same shape —
 * no changes at the call site.
 */
export const RasterCacheLive = Layer.sync(RasterCache, () => {
	const max = DEFAULT_MAX_ENTRIES;
	const map = new Map<string, RasterResponse>();
	return {
		get: (q) =>
			Effect.sync(() => {
				const key = cacheKey(q);
				const hit = map.get(key);
				if (!hit) return Option.none();
				// LRU touch: re-set so this key becomes most-recent.
				map.delete(key);
				map.set(key, hit);
				return Option.some(hit);
			}),
		set: (q, v) =>
			Effect.sync(() => {
				const key = cacheKey(q);
				if (map.has(key)) map.delete(key);
				map.set(key, v);
				while (map.size > max) {
					const oldest = map.keys().next().value;
					if (oldest === undefined) break;
					map.delete(oldest);
				}
			}),
	};
});
