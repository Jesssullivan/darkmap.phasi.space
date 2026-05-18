import { describe, expect, it } from 'vitest';
import { TtlCache } from './cache';

describe('TtlCache', () => {
	it('round-trips a value through get/set', () => {
		const c = new TtlCache<string>();
		c.set('hello', 'world');
		expect(c.get('hello')).toBe('world');
	});

	it('returns undefined for a miss', () => {
		const c = new TtlCache<string>();
		expect(c.get('missing')).toBeUndefined();
	});

	it('expires entries after ttl', () => {
		const c = new TtlCache<string>({ ttlMs: 1000 });
		c.set('a', 'A', 0);
		expect(c.get('a', 500)).toBe('A');
		expect(c.get('a', 2000)).toBeUndefined();
	});

	it('evicts oldest entries past maxEntries', () => {
		const c = new TtlCache<number>({ maxEntries: 3 });
		c.set('a', 1);
		c.set('b', 2);
		c.set('c', 3);
		c.set('d', 4);
		expect(c.get('a')).toBeUndefined();
		expect(c.get('d')).toBe(4);
		expect(c.size).toBe(3);
	});

	it('bumps an entry to most-recent on get (LRU refresh)', () => {
		const c = new TtlCache<number>({ maxEntries: 3 });
		c.set('a', 1);
		c.set('b', 2);
		c.set('c', 3);
		// Read 'a' so it becomes most-recent; next insertion should evict 'b'.
		expect(c.get('a')).toBe(1);
		c.set('d', 4);
		expect(c.get('b')).toBeUndefined();
		expect(c.get('a')).toBe(1);
	});

	it('overwriting a key resets its position to most-recent', () => {
		const c = new TtlCache<number>({ maxEntries: 3 });
		c.set('a', 1);
		c.set('b', 2);
		c.set('c', 3);
		c.set('a', 9); // re-set bumps a
		c.set('d', 4); // should evict b, not a
		expect(c.get('b')).toBeUndefined();
		expect(c.get('a')).toBe(9);
	});

	it('clear empties the cache', () => {
		const c = new TtlCache<number>();
		c.set('a', 1);
		c.set('b', 2);
		c.clear();
		expect(c.size).toBe(0);
		expect(c.get('a')).toBeUndefined();
	});
});
