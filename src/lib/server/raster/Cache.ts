import { Context, Effect, Layer, Option } from 'effect';
import type { RasterResponse, RasterTileRequest } from './RasterClient';

interface RasterCacheEntry {
	readonly response: RasterResponse;
	readonly storedAt: number;
}

interface RasterCacheOptions {
	readonly freshMs?: number;
	readonly maxEntries?: number;
	readonly now?: () => number;
	readonly staleMs?: number;
	readonly store?: Map<string, RasterCacheEntry>;
}

export class RasterCache extends Context.Tag('@darkmap/RasterCache')<
	RasterCache,
	{
		readonly get: (req: RasterTileRequest) => Effect.Effect<Option.Option<RasterResponse>>;
		readonly getStale: (req: RasterTileRequest) => Effect.Effect<Option.Option<RasterResponse>>;
		readonly set: (req: RasterTileRequest, v: RasterResponse) => Effect.Effect<void>;
	}
>() {}

export const rasterCacheKey = ({ upstreamLayer, tile }: RasterTileRequest): string =>
	`${upstreamLayer}::${tile.z}/${tile.x}/${tile.y}`;

const DEFAULT_FRESH_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1024;
const DEFAULT_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const sharedStore = new Map<string, RasterCacheEntry>();

const cloneResponse = (response: RasterResponse): RasterResponse => ({
	contentType: response.contentType,
	body: new Uint8Array(response.body),
});

const touch = (store: Map<string, RasterCacheEntry>, key: string, entry: RasterCacheEntry): void => {
	store.delete(key);
	store.set(key, entry);
};

export const makeRasterCacheLayer = (options: RasterCacheOptions = {}): Layer.Layer<RasterCache> => {
	const max = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	const now = options.now ?? Date.now;
	const store = options.store ?? new Map<string, RasterCacheEntry>();

	return Layer.succeed(RasterCache, {
		get: (req) =>
			Effect.sync(() => {
				const key = rasterCacheKey(req);
				const entry = store.get(key);
				if (!entry) return Option.none();
				if (now() - entry.storedAt > freshMs) return Option.none();
				touch(store, key, entry);
				return Option.some(cloneResponse(entry.response));
			}),
		getStale: (req) =>
			Effect.sync(() => {
				const key = rasterCacheKey(req);
				const entry = store.get(key);
				if (!entry) return Option.none();
				if (now() - entry.storedAt > freshMs + staleMs) return Option.none();
				touch(store, key, entry);
				return Option.some(cloneResponse(entry.response));
			}),
		set: (req, v) =>
			Effect.sync(() => {
				const key = rasterCacheKey(req);
				if (store.has(key)) store.delete(key);
				store.set(key, { response: cloneResponse(v), storedAt: now() });
				while (store.size > max) {
					const oldest = store.keys().next().value;
					if (oldest === undefined) break;
					store.delete(oldest);
				}
			}),
	});
};

/**
 * In-process LRU. Keyed on `(upstream layer, z, x, y)`. Phase 2 swap
 * target: replace with a Layer that talks to rustfs S3, same Tag, same
 * shape — no changes at the call site.
 */
export const RasterCacheLive = makeRasterCacheLayer({ store: sharedStore });
