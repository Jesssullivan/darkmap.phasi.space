/**
 * In-memory TTL cache for the geocode proxy (TIN-1302 sub 4).
 *
 * Lives in module scope on the SvelteKit server — one Map per
 * Node process. Goals:
 *   • Compress autocomplete repeats: "iths" → "ithac" → "ithaca"
 *     usually all end up looking the same to Photon once the
 *     final keystroke settles, and revisits within 5 min are free.
 *   • Bound the heap (max ~256 entries) so a pathological caller
 *     can't grow it without limit.
 *   • Lazy eviction on read miss; no background timer.
 *
 * NOT a substitute for an HTTP-level cache (CDN, edge worker). It's
 * just a "don't hit Photon for the same query twice in a minute"
 * defense. A future ticket can layer Cloudflare cache rules on top.
 */

export interface TtlCacheOptions {
	readonly maxEntries?: number;
	readonly ttlMs?: number;
}

export class TtlCache<V> {
	private readonly map = new Map<string, { value: V; expiresAt: number }>();
	private readonly max: number;
	private readonly ttl: number;

	constructor(opts: TtlCacheOptions = {}) {
		this.max = opts.maxEntries ?? 256;
		this.ttl = opts.ttlMs ?? 5 * 60 * 1000;
	}

	get(key: string, now: number = Date.now()): V | undefined {
		const entry = this.map.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= now) {
			this.map.delete(key);
			return undefined;
		}
		// Refresh LRU order: re-set to bump to most-recent position.
		this.map.delete(key);
		this.map.set(key, entry);
		return entry.value;
	}

	set(key: string, value: V, now: number = Date.now()): void {
		if (this.map.has(key)) this.map.delete(key);
		this.map.set(key, { value, expiresAt: now + this.ttl });
		// Evict oldest entries until we're under capacity.
		while (this.map.size > this.max) {
			const firstKey = this.map.keys().next().value;
			if (firstKey === undefined) break;
			this.map.delete(firstKey);
		}
	}

	get size(): number {
		return this.map.size;
	}

	/** Test-only: clear all entries. */
	clear(): void {
		this.map.clear();
	}
}
