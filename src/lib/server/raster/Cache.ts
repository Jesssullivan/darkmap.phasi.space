import { Context, Effect, Layer, Option } from 'effect';
import type { RasterResponse, RasterTileRequest } from './RasterClient';

export class RasterCache extends Context.Tag('@darkmap/RasterCache')<
	RasterCache,
	{
		readonly get: (req: RasterTileRequest) => Effect.Effect<Option.Option<RasterResponse>>;
		readonly set: (req: RasterTileRequest, v: RasterResponse) => Effect.Effect<void>;
	}
>() {}

const cacheKey = ({ upstreamLayer, tile }: RasterTileRequest): string =>
	`${upstreamLayer}::${tile.z}/${tile.x}/${tile.y}`;

const DEFAULT_MAX_ENTRIES = 1024;

/**
 * In-process LRU. Keyed on `(upstream layer, z, x, y)`. Phase 2 swap
 * target: replace with a Layer that talks to rustfs S3, same Tag, same
 * shape — no changes at the call site.
 */
export const RasterCacheLive = Layer.sync(RasterCache, () => {
	const max = DEFAULT_MAX_ENTRIES;
	const map = new Map<string, RasterResponse>();
	return {
		get: (req) =>
			Effect.sync(() => {
				const key = cacheKey(req);
				const hit = map.get(key);
				if (!hit) return Option.none();
				map.delete(key);
				map.set(key, hit);
				return Option.some(hit);
			}),
		set: (req, v) =>
			Effect.sync(() => {
				const key = cacheKey(req);
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
