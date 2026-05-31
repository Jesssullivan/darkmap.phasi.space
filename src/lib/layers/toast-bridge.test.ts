import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerErrorDebouncer, buildToast, reasonForLayer, type LayerToastPayload } from './toast-bridge';

/* ============================ reasonForLayer ============================ */

describe('reasonForLayer — message-based branches', () => {
	it('classifies an abort as "request aborted"', () => {
		expect(reasonForLayer({ layerId: 'viirs_2019', message: 'AbortError: signal aborted' })).toMatch(/abort/i);
	});

	it('classifies CORS messages', () => {
		expect(reasonForLayer({ layerId: 'viirs_2019', message: 'CORS policy blocked' })).toMatch(/CORS/);
	});

	it('classifies generic network messages', () => {
		expect(reasonForLayer({ layerId: 'viirs_2019', message: 'NetworkError when attempting to fetch' })).toMatch(
			/network/i,
		);
	});

	it('classifies connection refused', () => {
		expect(reasonForLayer({ layerId: 'viirs_2019', message: 'ECONNREFUSED 127.0.0.1' })).toMatch(/connection refused/i);
	});
});

describe('reasonForLayer — status-based branches', () => {
	it('502/503/504 → "upstream temporarily unavailable"', () => {
		for (const s of [502, 503, 504]) {
			expect(reasonForLayer({ layerId: 'x', status: s })).toMatch(/temporarily unavailable/i);
		}
	});

	it('401/403 → "credentials missing or expired"', () => {
		for (const s of [401, 403]) {
			expect(reasonForLayer({ layerId: 'x', status: s })).toMatch(/credentials/i);
		}
	});

	it('404 → "no tile for this view"', () => {
		expect(reasonForLayer({ layerId: 'x', status: 404 })).toMatch(/no tile/i);
	});

	it('429 → "rate-limited"', () => {
		expect(reasonForLayer({ layerId: 'x', status: 429 })).toMatch(/rate-limited/i);
	});

	it('generic 5xx → "upstream error <status>"', () => {
		expect(reasonForLayer({ layerId: 'x', status: 500 })).toMatch(/upstream error 500/);
	});

	it('generic 4xx → "bad request <status>"', () => {
		expect(reasonForLayer({ layerId: 'x', status: 418 })).toMatch(/bad request 418/);
	});
});

describe('reasonForLayer — fallback', () => {
	it('no status, no recognizable message → "tile load failed"', () => {
		expect(reasonForLayer({ layerId: 'x' })).toBe('tile load failed');
		expect(reasonForLayer({ layerId: 'x', message: '???' })).toBe('tile load failed');
	});
});

/* ============================== buildToast ============================== */

describe('buildToast', () => {
	it('uses the LAYERS label for a real layer id', () => {
		const t = buildToast({ layerId: 'viirs_2019', status: 502 });
		expect(t.text.startsWith('VIIRS 2019')).toBe(true);
		expect(t.text).toMatch(/temporarily unavailable/);
		expect(t.source).toBe('viirs_2019');
	});

	it('uses the BASEMAPS label suffixed with "basemap" for basemap ids', () => {
		const t = buildToast({ layerId: 'dark', status: 502 });
		expect(t.text.startsWith('Dark basemap')).toBe(true);
	});

	it('falls back to the raw id when nothing matches (defensive)', () => {
		const t = buildToast({ layerId: 'unknown-overlay', status: 404 });
		expect(t.text.startsWith('unknown-overlay')).toBe(true);
		expect(t.text).toMatch(/no tile/i);
	});
});

/* =========================== LayerErrorDebouncer =========================== */

describe('LayerErrorDebouncer', () => {
	let emitted: LayerToastPayload[];

	beforeEach(() => {
		vi.useFakeTimers();
		emitted = [];
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('flushes a single toast for one error after the window', () => {
		const d = new LayerErrorDebouncer((p) => emitted.push(p), { windowMs: 100 });
		d.enqueue({ layerId: 'viirs_2019', status: 502 });
		expect(emitted).toHaveLength(0);
		vi.advanceTimersByTime(100);
		expect(emitted).toHaveLength(1);
		expect(emitted[0].source).toBe('viirs_2019');
	});

	it('coalesces a burst of same-layer errors into one toast', () => {
		const d = new LayerErrorDebouncer((p) => emitted.push(p), { windowMs: 100 });
		for (let i = 0; i < 20; i++) d.enqueue({ layerId: 'viirs_2019', status: 502 });
		vi.advanceTimersByTime(100);
		expect(emitted).toHaveLength(1);
	});

	it('keeps the most recent status when coalescing (404 supersedes 502)', () => {
		const d = new LayerErrorDebouncer((p) => emitted.push(p), { windowMs: 100 });
		d.enqueue({ layerId: 'viirs_2019', status: 502 });
		d.enqueue({ layerId: 'viirs_2019', status: 404 });
		vi.advanceTimersByTime(100);
		expect(emitted[0].text).toMatch(/no tile/i);
	});

	it('emits one toast per distinct layerId', () => {
		const d = new LayerErrorDebouncer((p) => emitted.push(p), { windowMs: 100 });
		d.enqueue({ layerId: 'viirs_2019', status: 502 });
		d.enqueue({ layerId: 'world_atlas_2015', status: 502 });
		vi.advanceTimersByTime(100);
		expect(emitted).toHaveLength(2);
		const sources = emitted.map((e) => e.source).sort();
		expect(sources).toEqual(['viirs_2019', 'world_atlas_2015']);
	});

	it('cancel(layerId) drops the pending flush for that layer only', () => {
		const d = new LayerErrorDebouncer((p) => emitted.push(p), { windowMs: 100 });
		d.enqueue({ layerId: 'viirs_2019', status: 502 });
		d.enqueue({ layerId: 'dark', status: 502 });
		d.cancel('viirs_2019');
		vi.advanceTimersByTime(100);
		expect(emitted).toHaveLength(1);
		expect(emitted[0].source).toBe('dark');
	});

	it('dispose() cancels every pending flush', () => {
		const d = new LayerErrorDebouncer((p) => emitted.push(p), { windowMs: 100 });
		d.enqueue({ layerId: 'viirs_2019', status: 502 });
		d.enqueue({ layerId: 'dark', status: 502 });
		d.dispose();
		vi.advanceTimersByTime(100);
		expect(emitted).toEqual([]);
	});

	it('defaults windowMs to 500ms when not specified', () => {
		const d = new LayerErrorDebouncer((p) => emitted.push(p));
		d.enqueue({ layerId: 'viirs_2019', status: 502 });
		vi.advanceTimersByTime(499);
		expect(emitted).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(emitted).toHaveLength(1);
	});
});
