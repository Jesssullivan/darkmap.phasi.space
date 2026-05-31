import { describe, expect, it } from 'vitest';
import { HEALTH_IDLE, healthLabel, healthTone, reduceHealth, type HealthEvent, type LayerHealth } from './health-state';

const apply = (events: HealthEvent[]): LayerHealth => events.reduce(reduceHealth, HEALTH_IDLE);

describe('reduceHealth — single transitions', () => {
	it('mount transitions idle → loading', () => {
		expect(apply([{ type: 'mount' }])).toEqual({ tag: 'loading' });
	});

	it('tile-ok transitions loading → rendered', () => {
		expect(apply([{ type: 'mount' }, { type: 'tile-ok' }])).toEqual({ tag: 'rendered' });
	});

	it('tile-ok carries the cached flag through', () => {
		expect(apply([{ type: 'mount' }, { type: 'tile-ok', cached: true }])).toEqual({
			tag: 'rendered',
			cached: true,
		});
	});

	it('tile-empty transitions to empty with reason', () => {
		expect(apply([{ type: 'mount' }, { type: 'tile-empty', reason: 'GIBS 204' }])).toEqual({
			tag: 'empty',
			reason: 'GIBS 204',
		});
	});

	it('tile-stale transitions to stale', () => {
		expect(apply([{ type: 'mount' }, { type: 'tile-stale' }])).toEqual({ tag: 'stale' });
	});

	it('tile-error transitions to error with status', () => {
		expect(apply([{ type: 'mount' }, { type: 'tile-error', reason: 'upstream 503', status: 503 }])).toEqual({
			tag: 'error',
			reason: 'upstream 503',
			status: 503,
		});
	});

	it('unmount drops back to idle', () => {
		expect(apply([{ type: 'mount' }, { type: 'tile-ok' }, { type: 'unmount' }])).toBe(HEALTH_IDLE);
	});
});

describe('reduceHealth — invariants', () => {
	it('rendered state survives a transient tile-error (no downgrade)', () => {
		const result = apply([{ type: 'mount' }, { type: 'tile-ok' }, { type: 'tile-error', reason: 'one bad tile' }]);
		expect(result.tag).toBe('rendered');
	});

	it('tile-abort is a no-op (rapid pans must not surface as errors)', () => {
		const result = apply([{ type: 'mount' }, { type: 'tile-abort' }]);
		expect(result.tag).toBe('loading');
	});

	it('error after empty still surfaces the error', () => {
		const result = apply([
			{ type: 'mount' },
			{ type: 'tile-empty' },
			{ type: 'tile-error', reason: 'now dead', status: 502 },
		]);
		expect(result.tag).toBe('error');
		expect(result.status).toBe(502);
	});

	it('rendered → empty (e.g. user pans out of data area) transitions cleanly', () => {
		const result = apply([{ type: 'mount' }, { type: 'tile-ok' }, { type: 'tile-empty' }]);
		expect(result.tag).toBe('empty');
	});

	it('full lifecycle round-trip mount → ok → unmount → mount → empty → unmount → idle', () => {
		const result = apply([
			{ type: 'mount' },
			{ type: 'tile-ok' },
			{ type: 'unmount' },
			{ type: 'mount' },
			{ type: 'tile-empty' },
			{ type: 'unmount' },
		]);
		expect(result).toBe(HEALTH_IDLE);
	});
});

describe('healthLabel + healthTone — UI helpers', () => {
	it('idle has empty label and neutral tone', () => {
		expect(healthLabel({ tag: 'idle' })).toBe('');
		expect(healthTone({ tag: 'idle' })).toBe('neutral');
	});

	it('rendered (live) is good; rendered cached is good too', () => {
		expect(healthLabel({ tag: 'rendered' })).toBe('live');
		expect(healthLabel({ tag: 'rendered', cached: true })).toBe('cached');
		expect(healthTone({ tag: 'rendered' })).toBe('good');
	});

	it('empty and stale are warn-toned', () => {
		expect(healthLabel({ tag: 'empty' })).toBe('no data');
		expect(healthLabel({ tag: 'stale' })).toBe('stale');
		expect(healthTone({ tag: 'empty' })).toBe('warn');
		expect(healthTone({ tag: 'stale' })).toBe('warn');
	});

	it('error includes status when present', () => {
		expect(healthLabel({ tag: 'error', reason: 'x', status: 502 })).toBe('error 502');
		expect(healthLabel({ tag: 'error', reason: 'x' })).toBe('error');
		expect(healthTone({ tag: 'error', reason: 'x' })).toBe('bad');
	});

	it('loading is neutral', () => {
		expect(healthLabel({ tag: 'loading' })).toBe('loading');
		expect(healthTone({ tag: 'loading' })).toBe('neutral');
	});
});
