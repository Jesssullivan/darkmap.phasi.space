import { describe, expect, it } from 'vitest';
import { comparePair, crossValidate, DEFAULT_CROSSVAL, type SourceReading } from './aq-crossval';

const r = (value: number | null, over: Partial<SourceReading> = {}): SourceReading => ({
	id: 'x',
	label: 'X',
	kind: 'modeled',
	value,
	...over,
});

describe('comparePair', () => {
	it('computes signed bias a − b on overlapping data', () => {
		const p = comparePair(r(20), r(12), 'pm25', 'µg/m³');
		expect(p).not.toBeNull();
		expect(p!.bias).toBeCloseTo(8, 6);
	});

	it('returns null (NOT zero bias) when only the first source has data', () => {
		expect(comparePair(r(20), r(null), 'pm25', 'µg/m³')).toBeNull();
	});

	it('returns null (NOT zero bias) when only the second source has data', () => {
		expect(comparePair(r(null), r(15), 'pm25', 'µg/m³')).toBeNull();
	});

	it('returns null when both sources are absent', () => {
		expect(comparePair(r(null), r(null), 'pm25', 'µg/m³')).toBeNull();
	});

	it('treats null as no-data, never as 0 (a real 0 differs from null)', () => {
		// value 0 paired against null is still "no comparison".
		expect(comparePair(r(0), r(null), 'pm25', 'µg/m³')).toBeNull();
		// two real values, one of them 0, DO compare.
		const p = comparePair(r(0), r(0), 'pm25', 'µg/m³');
		expect(p).not.toBeNull();
		expect(p!.bias).toBe(0);
	});

	it('flags agreement within the relative tolerance', () => {
		const p = comparePair(r(20), r(22), 'pm25', 'µg/m³');
		expect(p!.level).toBe('agree');
	});

	it('flags differ outside tolerance but same regime', () => {
		// both above clean (12) and below unhealthy (35.5): no threshold cross,
		// but relDiff > 0.35.
		const p = comparePair(r(15), r(30), 'pm25', 'µg/m³');
		expect(p!.level).toBe('differ');
	});

	it('flags conflict when one source is clean and the other unhealthy', () => {
		const p = comparePair(r(5), r(60), 'pm25', 'µg/m³');
		expect(p!.level).toBe('conflict');
		expect(p!.note.toLowerCase()).toContain('unhealthy');
		expect(p!.note.toLowerCase()).toContain('clean');
	});

	it('uses AOD clear/turbid thresholds for the aod550 quantity', () => {
		const p = comparePair(r(0.05), r(0.6), 'aod550', '');
		expect(p!.level).toBe('conflict');
	});

	it('treats both-near-zero as agreement (no scale to divide by)', () => {
		const p = comparePair(r(0), r(0), 'aod550', '');
		expect(p!.relDiff).toBeNull();
		expect(p!.level).toBe('agree');
	});
});

describe('crossValidate', () => {
	it('compares OpenAQ↔CAMS PM2.5 and AOD only where both have data', () => {
		const res = crossValidate({
			openaqPm25: 20,
			openaqAod550FromPm25: 0.24,
			camsPm25: 22,
			camsAod550: 0.2,
		});
		expect(res.pairs.map((p) => p.quantity).sort()).toEqual(['aod550', 'pm25']);
		expect(res.emptyReason).toBeNull();
		expect(res.hasConflict).toBe(false);
	});

	it('one source present → no comparison, honest reason (not zero bias)', () => {
		const res = crossValidate({
			openaqPm25: 20,
			openaqAod550FromPm25: 0.24,
			camsPm25: null,
			camsAod550: null,
		});
		expect(res.pairs).toHaveLength(0);
		expect(res.emptyReason).toMatch(/only one source/i);
	});

	it('all-null → honest empty, distinct reason', () => {
		const res = crossValidate({
			openaqPm25: null,
			openaqAod550FromPm25: null,
			camsPm25: null,
			camsAod550: null,
		});
		expect(res.pairs).toHaveLength(0);
		expect(res.hasConflict).toBe(false);
		expect(res.emptyReason).toMatch(/no air-quality source/i);
	});

	it('only the quantity with both sources is compared (PM2.5 only)', () => {
		const res = crossValidate({
			openaqPm25: 18,
			openaqAod550FromPm25: null,
			camsPm25: 20,
			camsAod550: 0.3, // no openaq bridge → no AOD pair
		});
		expect(res.pairs.map((p) => p.quantity)).toEqual(['pm25']);
	});

	it('surfaces a clean-vs-unhealthy conflict', () => {
		const res = crossValidate({
			openaqPm25: 70,
			openaqAod550FromPm25: null,
			camsPm25: 6,
			camsAod550: null,
		});
		expect(res.hasConflict).toBe(true);
		expect(res.pairs[0].level).toBe('conflict');
	});

	it('labels stations measured and CAMS modeled', () => {
		const res = crossValidate({
			openaqPm25: 20,
			openaqAod550FromPm25: null,
			camsPm25: 22,
			camsAod550: null,
		});
		const pair = res.pairs[0];
		expect(pair.a.kind).toBe('measured');
		expect(pair.b.kind).toBe('modeled');
	});

	it('respects an injected config (tighter agreement tolerance)', () => {
		const strict = { ...DEFAULT_CROSSVAL, agreeRelTol: 0.01 };
		const res = crossValidate({ openaqPm25: 20, openaqAod550FromPm25: null, camsPm25: 22, camsAod550: null }, strict);
		expect(res.pairs[0].level).toBe('differ');
	});
});
