import { describe, expect, it } from 'vitest';
import { buildCacheBadge, cachePillToneClass, type CacheBadgeKind } from './badge';

const NOW = Date.UTC(2026, 4, 28, 12, 0, 0); // 2026-05-28T12:00:00Z
const minutesAgo = (n: number): number => NOW - n * 60_000;

/* ------------------------------ live ------------------------------ */

describe('buildCacheBadge — live', () => {
	it('online + live → label "live", tone "live"', () => {
		const v = buildCacheBadge({ online: true, kind: 'live' }, NOW);
		expect(v.label).toBe('live');
		expect(v.tone).toBe('live');
		expect(v.detail.length).toBeGreaterThan(0);
	});

	it('offline + live → label "offline live" (unusual but well-defined)', () => {
		const v = buildCacheBadge({ online: false, kind: 'live' }, NOW);
		expect(v.label).toBe('offline live');
		expect(v.tone).toBe('live');
		expect(v.detail).toMatch(/offline/i);
	});
});

/* ------------------------------ cached ------------------------------ */

describe('buildCacheBadge — cached', () => {
	it('online + cached → label "cache", tone "cached", detail mentions age when storedAtMs given', () => {
		const v = buildCacheBadge({ online: true, kind: 'cached', storedAtMs: minutesAgo(15) }, NOW);
		expect(v.label).toBe('cache');
		expect(v.tone).toBe('cached');
		expect(v.detail).toMatch(/15m ago/);
	});

	it('offline + cached → label "offline cache", detail mentions offline + age', () => {
		const v = buildCacheBadge({ online: false, kind: 'cached', storedAtMs: minutesAgo(120) }, NOW);
		expect(v.label).toBe('offline cache');
		expect(v.tone).toBe('cached');
		expect(v.detail).toMatch(/offline/i);
		expect(v.detail).toMatch(/2h ago/);
	});

	it('cached without storedAtMs → detail omits age but still useful', () => {
		const v = buildCacheBadge({ online: true, kind: 'cached' }, NOW);
		expect(v.label).toBe('cache');
		expect(v.detail).toMatch(/local cache/i);
		expect(v.detail).not.toMatch(/ago/);
	});
});

/* ------------------------------ stale ------------------------------ */

describe('buildCacheBadge — stale', () => {
	it('online + stale → "stale" with detail explaining failed fresh fetch', () => {
		const v = buildCacheBadge({ online: true, kind: 'stale', storedAtMs: minutesAgo(45) }, NOW);
		expect(v.label).toBe('stale');
		expect(v.tone).toBe('stale');
		expect(v.detail).toMatch(/fresh fetch failed/i);
		expect(v.detail).toMatch(/45m ago/);
	});

	it('offline + stale → "offline stale" — the local copy is all we have', () => {
		const v = buildCacheBadge({ online: false, kind: 'stale', storedAtMs: minutesAgo(60 * 25) }, NOW);
		expect(v.label).toBe('offline stale');
		expect(v.tone).toBe('stale');
		expect(v.detail).toMatch(/offline/i);
		expect(v.detail).toMatch(/1d ago/);
	});
});

/* ------------------------------ loading ------------------------------ */

describe('buildCacheBadge — loading', () => {
	it('online + loading → "loading"', () => {
		const v = buildCacheBadge({ online: true, kind: 'loading' }, NOW);
		expect(v.label).toBe('loading');
		expect(v.tone).toBe('loading');
	});

	it('offline + loading → "offline"', () => {
		const v = buildCacheBadge({ online: false, kind: 'loading' }, NOW);
		expect(v.label).toBe('offline');
		expect(v.tone).toBe('loading');
	});
});

/* ------------------------------ error / empty ------------------------------ */

describe('buildCacheBadge — error and empty', () => {
	it('error: label/tone are stable across online state', () => {
		const onl = buildCacheBadge({ online: true, kind: 'error' }, NOW);
		const off = buildCacheBadge({ online: false, kind: 'error' }, NOW);
		expect(onl.label).toBe('error');
		expect(off.label).toBe('error');
		expect(onl.tone).toBe('error');
		expect(off.tone).toBe('error');
		expect(onl.detail).not.toBe(off.detail);
	});

	it('empty: label "no data"', () => {
		const v = buildCacheBadge({ online: true, kind: 'empty' }, NOW);
		expect(v.label).toBe('no data');
		expect(v.tone).toBe('empty');
	});
});

/* ------------------------------ age formatting ------------------------------ */

describe('buildCacheBadge — age formatting', () => {
	it('formats < 1 minute as "just now"', () => {
		// 10s elapsed → Math.round rounds to 0 minutes → "just now".
		const v = buildCacheBadge({ online: true, kind: 'cached', storedAtMs: NOW - 10_000 }, NOW);
		expect(v.detail).toMatch(/just now/);
	});

	it('formats minutes', () => {
		const v = buildCacheBadge({ online: true, kind: 'cached', storedAtMs: minutesAgo(7) }, NOW);
		expect(v.detail).toMatch(/7m ago/);
	});

	it('formats hours', () => {
		const v = buildCacheBadge({ online: true, kind: 'cached', storedAtMs: minutesAgo(60 * 5) }, NOW);
		expect(v.detail).toMatch(/5h ago/);
	});

	it('formats days', () => {
		const v = buildCacheBadge({ online: true, kind: 'cached', storedAtMs: minutesAgo(60 * 24 * 3) }, NOW);
		expect(v.detail).toMatch(/3d ago/);
	});
});

/* ------------------------------ matrix sanity ------------------------------ */

describe('buildCacheBadge — every kind × online combination produces a non-empty view', () => {
	const KINDS: ReadonlyArray<CacheBadgeKind> = ['live', 'cached', 'stale', 'loading', 'error', 'empty'];
	for (const kind of KINDS) {
		for (const online of [true, false]) {
			it(`{ kind: ${kind}, online: ${online} } → non-empty label, tone, detail`, () => {
				const v = buildCacheBadge({ online, kind }, NOW);
				expect(v.label.length).toBeGreaterThan(0);
				expect(v.tone.length).toBeGreaterThan(0);
				expect(v.detail.length).toBeGreaterThan(0);
			});
		}
	}
});

/* ------------------------------ pill class helper ------------------------------ */

describe('cachePillToneClass', () => {
	it('maps every tone to a stable `cache-pill-<tone>` class', () => {
		expect(cachePillToneClass('live')).toBe('cache-pill-live');
		expect(cachePillToneClass('cached')).toBe('cache-pill-cached');
		expect(cachePillToneClass('stale')).toBe('cache-pill-stale');
		expect(cachePillToneClass('loading')).toBe('cache-pill-loading');
		expect(cachePillToneClass('error')).toBe('cache-pill-error');
		expect(cachePillToneClass('empty')).toBe('cache-pill-empty');
	});
});
