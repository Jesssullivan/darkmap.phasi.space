import { describe, expect, it } from 'vitest';
import { decodeHash, encodeHash } from './url-hash';

describe('encodeHash', () => {
	it('returns empty string for empty state', () => {
		expect(encodeHash({})).toBe('');
	});

	it('encodes view only', () => {
		expect(encodeHash({ view: { lat: 42.4434, lon: -76.5019, zoom: 9 } })).toBe('#m=42.4434,-76.5019,9');
	});

	it('rounds lat/lon to 4 decimals and zoom to 2', () => {
		const out = encodeHash({ view: { lat: 42.443412345, lon: -76.501987, zoom: 9.876 } });
		expect(out).toBe('#m=42.4434,-76.502,9.88');
	});

	it('encodes a single layer with opacity', () => {
		const out = encodeHash({ layers: new Map([['viirs_2019', 0.85]]) });
		expect(out).toBe('#l=viirs_2019:0.85');
	});

	it('encodes multiple layers separated by comma', () => {
		const out = encodeHash({
			layers: new Map([
				['viirs_2019', 0.85],
				['world_atlas_2015', 0.7],
			]),
		});
		expect(out).toBe('#l=viirs_2019:0.85,world_atlas_2015:0.7');
	});

	it('combines view and layers with &', () => {
		const out = encodeHash({
			view: { lat: 42.4434, lon: -76.5019, zoom: 9 },
			layers: new Map([['viirs_2019', 0.85]]),
		});
		expect(out).toBe('#m=42.4434,-76.5019,9&l=viirs_2019:0.85');
	});

	it('omits layers segment when empty map', () => {
		const out = encodeHash({
			view: { lat: 42.4434, lon: -76.5019, zoom: 9 },
			layers: new Map(),
		});
		expect(out).toBe('#m=42.4434,-76.5019,9');
	});
});

describe('decodeHash', () => {
	it('returns empty state for empty input', () => {
		expect(decodeHash('')).toEqual({});
		expect(decodeHash('#')).toEqual({});
	});

	it('parses view with or without leading #', () => {
		expect(decodeHash('#m=42.4434,-76.5019,9').view).toEqual({
			lat: 42.4434,
			lon: -76.5019,
			zoom: 9,
		});
		expect(decodeHash('m=42.4434,-76.5019,9').view).toEqual({
			lat: 42.4434,
			lon: -76.5019,
			zoom: 9,
		});
	});

	it('parses layers map', () => {
		const out = decodeHash('#l=viirs_2019:0.85,world_atlas_2015:0.7');
		expect(out.layers?.get('viirs_2019')).toBe(0.85);
		expect(out.layers?.get('world_atlas_2015')).toBe(0.7);
	});

	it('parses combined hash', () => {
		const out = decodeHash('#m=42.44,-76.5,9&l=viirs_2017:0.5');
		expect(out.view).toEqual({ lat: 42.44, lon: -76.5, zoom: 9 });
		expect(out.layers?.get('viirs_2017')).toBe(0.5);
	});

	it('clamps opacity to [0, 1]', () => {
		const out = decodeHash('#l=viirs_2019:-0.5,world_atlas_2015:2');
		expect(out.layers?.get('viirs_2019')).toBe(0);
		expect(out.layers?.get('world_atlas_2015')).toBe(1);
	});

	it('skips malformed view segments', () => {
		expect(decodeHash('#m=foo,bar,baz').view).toBeUndefined();
		expect(decodeHash('#m=42.4434').view).toBeUndefined();
	});

	it('layer without opacity defaults to 1.0', () => {
		const out = decodeHash('#l=viirs_2019');
		expect(out.layers?.get('viirs_2019')).toBe(1);
	});

	it('round-trips via encode -> decode', () => {
		const original = {
			view: { lat: 42.4434, lon: -76.5019, zoom: 9 },
			layers: new Map([
				['viirs_2019', 0.85],
				['world_atlas_2015', 0.7],
			]),
		};
		const encoded = encodeHash(original);
		const decoded = decodeHash(encoded);
		expect(decoded.view).toEqual(original.view);
		expect([...(decoded.layers ?? [])]).toEqual([...original.layers]);
	});

	it('parses + round-trips the basemap segment', () => {
		const out = decodeHash('#m=42.44,-76.5,9&l=viirs_2019:0.85&b=satellite');
		expect(out.basemap).toBe('satellite');
		const back = encodeHash(out);
		expect(back).toContain('b=satellite');
	});

	it('omits basemap when undefined', () => {
		expect(encodeHash({ view: { lat: 1, lon: 2, zoom: 3 } })).toBe('#m=1,2,3');
	});

	it('encodes the ephemeris-cursor time as minute-precision ISO UTC', () => {
		const out = encodeHash({ time: new Date('2024-12-21T17:00:00Z') });
		expect(out).toBe('#et=2024-12-21T17:00Z');
	});

	it('truncates sub-minute precision when encoding', () => {
		const out = encodeHash({ time: new Date('2024-12-21T17:00:42.987Z') });
		expect(out).toBe('#et=2024-12-21T17:00Z');
	});

	it('round-trips the time segment with minute precision', () => {
		const t = new Date('2024-12-21T17:00:00Z');
		const back = decodeHash(encodeHash({ time: t }));
		expect(back.time?.getTime()).toBe(t.getTime());
	});

	it('accepts a full ISO-8601 instant on decode (hand-edited URLs)', () => {
		const back = decodeHash('#et=2024-12-21T17:00:42.987Z');
		expect(back.time?.toISOString()).toBe('2024-12-21T17:00:42.987Z');
	});

	it('ignores malformed et segments', () => {
		expect(decodeHash('#et=nonsense').time).toBeUndefined();
	});

	it('encodes &t=YYYY-MM for the active VIIRS monthly composite', () => {
		expect(encodeHash({ monthlyMonth: { year: 2024, month: 7 } })).toBe('#t=2024-07');
	});

	it('zero-pads single-digit months in t=', () => {
		expect(encodeHash({ monthlyMonth: { year: 2012, month: 4 } })).toBe('#t=2012-04');
	});

	it('decodes &t=YYYY-MM back into MonthlyMonth', () => {
		expect(decodeHash('#t=2020-07').monthlyMonth).toEqual({ year: 2020, month: 7 });
		expect(decodeHash('#t=2012-04').monthlyMonth).toEqual({ year: 2012, month: 4 });
	});

	it('rejects malformed t= values (out-of-range month, no dash, etc.)', () => {
		expect(decodeHash('#t=2024-13').monthlyMonth).toBeUndefined();
		expect(decodeHash('#t=2024-00').monthlyMonth).toBeUndefined();
		expect(decodeHash('#t=2024').monthlyMonth).toBeUndefined();
		expect(decodeHash('#t=garbage').monthlyMonth).toBeUndefined();
	});

	it('encodes &p=1 only when autoplay is true', () => {
		expect(encodeHash({ monthlyAutoplay: true })).toBe('#p=1');
		expect(encodeHash({ monthlyAutoplay: false })).toBe('');
		expect(encodeHash({})).toBe('');
	});

	it('decodes &p=1 only when value is exactly 1', () => {
		expect(decodeHash('#p=1').monthlyAutoplay).toBe(true);
		expect(decodeHash('#p=0').monthlyAutoplay).toBeUndefined();
		expect(decodeHash('#p=true').monthlyAutoplay).toBeUndefined();
		expect(decodeHash('').monthlyAutoplay).toBeUndefined();
	});

	it('round-trips a full hash with view + month + autoplay', () => {
		const original = {
			view: { lat: 42.4434, lon: -76.5019, zoom: 9 },
			monthlyMonth: { year: 2020, month: 7 },
			monthlyAutoplay: true,
		};
		const back = decodeHash(encodeHash(original));
		expect(back.view).toEqual(original.view);
		expect(back.monthlyMonth).toEqual(original.monthlyMonth);
		expect(back.monthlyAutoplay).toBe(true);
	});
});
