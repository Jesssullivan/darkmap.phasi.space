import { describe, expect, it } from 'vitest';
import { computeTrend, shapeHistory, type HourlyPoint, type V3HourlyResult } from './openaq-history-shape';

/* ------------------------------ fixtures ------------------------------ */

const NOW = Date.parse('2026-05-30T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** A v3 `/sensors/{id}/hours` row ending at the given hour. */
const row = (hourUtc: string, value: number | null, units = 'µg/m³'): V3HourlyResult => ({
	value,
	parameter: { name: 'pm25', units },
	period: {
		datetimeFrom: { utc: hourUtc },
		datetimeTo: { utc: hourUtc },
	},
});

const pt = (at: string, value: number): HourlyPoint => ({ at, value });

const baseArgs = {
	parameter: 'pm25' as const,
	windowFrom: '2026-05-29T12:00:00Z',
	windowTo: '2026-05-30T12:00:00Z',
	nowMs: NOW,
	staleAfterMs: DAY,
};

/* ----------------------------- computeTrend ----------------------------- */

describe('computeTrend', () => {
	it('returns flat with null delta for <2 samples', () => {
		expect(computeTrend([], 0)).toEqual({ direction: 'flat', delta: null });
		expect(computeTrend([pt('2026-05-30T10:00:00Z', 5)], 0)).toEqual({ direction: 'flat', delta: null });
	});

	it('reports rising when the newer half mean exceeds the older half', () => {
		const r = computeTrend(
			[
				pt('2026-05-30T08:00:00Z', 2),
				pt('2026-05-30T09:00:00Z', 4),
				pt('2026-05-30T10:00:00Z', 8),
				pt('2026-05-30T11:00:00Z', 10),
			],
			0,
		);
		expect(r.direction).toBe('rising');
		expect(r.delta).toBeGreaterThan(0);
	});

	it('reports falling when the newer half mean is below the older half', () => {
		const r = computeTrend(
			[
				pt('2026-05-30T08:00:00Z', 10),
				pt('2026-05-30T09:00:00Z', 8),
				pt('2026-05-30T10:00:00Z', 4),
				pt('2026-05-30T11:00:00Z', 2),
			],
			0,
		);
		expect(r.direction).toBe('falling');
		expect(r.delta).toBeLessThan(0);
	});

	it('reads flat within the flatBand tolerance', () => {
		const r = computeTrend([pt('2026-05-30T10:00:00Z', 5), pt('2026-05-30T11:00:00Z', 5.4)], 1);
		expect(r.direction).toBe('flat');
	});

	it('excludes the shared middle sample for an odd count', () => {
		// older=[2], newer=[10]; middle 100 is ignored, so the spike does not flip the sign.
		const r = computeTrend(
			[pt('2026-05-30T09:00:00Z', 2), pt('2026-05-30T10:00:00Z', 100), pt('2026-05-30T11:00:00Z', 10)],
			0,
		);
		expect(r.direction).toBe('rising');
		expect(r.delta).toBe(8);
	});
});

/* ------------------------------ shapeHistory ------------------------------ */

describe('shapeHistory', () => {
	it('keeps only real samples and computes the mean over them (gaps do not pull toward 0)', () => {
		const series = shapeHistory({
			...baseArgs,
			results: [
				row('2026-05-30T09:00:00Z', 10),
				row('2026-05-30T10:00:00Z', null), // gap — absent value
				row('2026-05-30T11:00:00Z', 20),
			],
		});
		expect(series.sampleCount).toBe(2);
		expect(series.points.map((p) => p.value)).toEqual([10, 20]);
		// mean over the TWO real samples = 15, NOT 30/3 (which would treat the gap as 0).
		expect(series.mean).toBe(15);
		expect(series.min).toBe(10);
		expect(series.max).toBe(20);
	});

	it('sorts oldest-first regardless of input order', () => {
		const series = shapeHistory({
			...baseArgs,
			results: [row('2026-05-30T11:00:00Z', 3), row('2026-05-30T09:00:00Z', 1), row('2026-05-30T10:00:00Z', 2)],
		});
		expect(series.points.map((p) => p.value)).toEqual([1, 2, 3]);
		expect(series.latestValue).toBe(3);
		expect(series.latestAt).toBe('2026-05-30T11:00:00Z');
	});

	it('drops non-finite values and undatable rows', () => {
		const series = shapeHistory({
			...baseArgs,
			results: [
				row('2026-05-30T09:00:00Z', Number.NaN),
				{ value: 5, parameter: { name: 'pm25' }, period: null }, // no date → dropped
				row('2026-05-30T11:00:00Z', 7),
			],
		});
		expect(series.sampleCount).toBe(1);
		expect(series.points[0].value).toBe(7);
	});

	it('preserves a real zero as a sample (null != 0)', () => {
		const series = shapeHistory({
			...baseArgs,
			results: [row('2026-05-30T10:00:00Z', 0), row('2026-05-30T11:00:00Z', 4)],
		});
		expect(series.sampleCount).toBe(2);
		expect(series.mean).toBe(2);
		expect(series.min).toBe(0);
	});

	it('yields an honest empty series for no usable rows', () => {
		const series = shapeHistory({
			...baseArgs,
			results: [row('2026-05-30T10:00:00Z', null), row('2026-05-30T11:00:00Z', null)],
		});
		expect(series.sampleCount).toBe(0);
		expect(series.points).toEqual([]);
		expect(series.mean).toBeNull();
		expect(series.min).toBeNull();
		expect(series.max).toBeNull();
		expect(series.latestAt).toBeNull();
		expect(series.trend).toBe('flat');
		expect(series.trendDelta).toBeNull();
	});

	it('captures units from the first row that carries them', () => {
		const series = shapeHistory({ ...baseArgs, results: [row('2026-05-30T11:00:00Z', 5, 'ppm')] });
		expect(series.units).toBe('ppm');
	});

	it('echoes the requested window', () => {
		const series = shapeHistory({ ...baseArgs, results: [row('2026-05-30T11:00:00Z', 5)] });
		expect(series.windowFrom).toBe(baseArgs.windowFrom);
		expect(series.windowTo).toBe(baseArgs.windowTo);
	});

	it('flags a years-old series as stale (never presented as current)', () => {
		const series = shapeHistory({
			...baseArgs,
			results: [row('2019-07-01T10:00:00Z', 12), row('2019-07-01T11:00:00Z', 14)],
		});
		expect(series.sampleCount).toBe(2);
		expect(series.stale).toBe(true);
	});

	it('marks a fresh series not stale', () => {
		const series = shapeHistory({
			...baseArgs,
			results: [row('2026-05-30T10:00:00Z', 12), row('2026-05-30T11:30:00Z', 14)],
		});
		expect(series.stale).toBe(false);
	});

	it('treats an empty series as stale', () => {
		const series = shapeHistory({ ...baseArgs, results: [] });
		expect(series.stale).toBe(true);
	});

	it('uses datetimeFrom when datetimeTo is absent', () => {
		const series = shapeHistory({
			...baseArgs,
			results: [
				{
					value: 9,
					parameter: { name: 'pm25', units: 'µg/m³' },
					period: { datetimeFrom: { utc: '2026-05-30T11:00:00Z' } },
				},
			],
		});
		expect(series.points[0].at).toBe('2026-05-30T11:00:00Z');
	});
});
