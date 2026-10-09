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

	it('parses &t= and &p= monthly fields alongside other segments (TIN-1301)', () => {
		const back = decodeHash('#m=42.4434,-76.5019,9&t=2020-07&p=1');
		expect(back.view).toEqual({ lat: 42.4434, lon: -76.5019, zoom: 9 });
		expect(back.month).toBe('2020-07');
		expect(back.autoplay).toBe(true);
	});
});

describe('TimeDock month/autoplay segment (TIN-1301 subtask 2)', () => {
	it('encodes a month cursor without autoplay', () => {
		expect(encodeHash({ month: '2019-07' })).toBe('#t=2019-07');
	});

	it('encodes a month cursor with autoplay', () => {
		expect(encodeHash({ month: '2019-07', autoplay: true })).toBe('#t=2019-07&p=1');
	});

	it('omits p= when autoplay is false', () => {
		expect(encodeHash({ month: '2019-07', autoplay: false })).toBe('#t=2019-07');
	});

	it('round-trips decodeHash(encodeHash(...)) for a month + autoplay state', () => {
		const state = { month: '2019-07', autoplay: true };
		expect(decodeHash(encodeHash(state))).toEqual(state);
	});

	it('round-trips a month without autoplay (autoplay key absent, not false)', () => {
		const state = { month: '2026-04' };
		const roundtripped = decodeHash(encodeHash(state));
		expect(roundtripped.month).toBe('2026-04');
		expect(roundtripped.autoplay).toBeUndefined();
	});

	it('falls back to no cursor for a malformed month (bad shape, out-of-range month, garbage)', () => {
		expect(decodeHash('#t=2019-13').month).toBeUndefined(); // month 13 doesn't exist
		expect(decodeHash('#t=19-07').month).toBeUndefined(); // 2-digit year
		expect(decodeHash('#t=2019-7').month).toBeUndefined(); // unpadded month
		expect(decodeHash('#t=not-a-month').month).toBeUndefined();
		expect(decodeHash('#t=').month).toBeUndefined();
	});

	it('accepts every valid month boundary (01 and 12)', () => {
		expect(decodeHash('#t=2019-01').month).toBe('2019-01');
		expect(decodeHash('#t=2019-12').month).toBe('2019-12');
	});

	it('drops a stray p=1 when there is no valid month cursor to pair it with', () => {
		expect(decodeHash('#p=1').autoplay).toBeUndefined();
		expect(decodeHash('#t=bad-month&p=1').autoplay).toBeUndefined();
	});

	it('does not set autoplay for any p= value other than exactly "1"', () => {
		expect(decodeHash('#t=2019-07&p=true').autoplay).toBeUndefined();
		expect(decodeHash('#t=2019-07&p=0').autoplay).toBeUndefined();
	});

	it('combines with view + layers + lens in one hash', () => {
		const out = decodeHash('#m=42.4434,-76.5019,9&l=viirs_2019:0.85&lens=air&t=2019-07&p=1');
		expect(out.view).toEqual({ lat: 42.4434, lon: -76.5019, zoom: 9 });
		expect(out.layers).toEqual(new Map([['viirs_2019', 0.85]]));
		expect(out.lens).toBe('air');
		expect(out.month).toBe('2019-07');
		expect(out.autoplay).toBe(true);
	});
});

describe('lens segment', () => {
	it('encodes a non-default lens', () => {
		expect(encodeHash({ lens: 'air' })).toBe('#lens=air');
		expect(encodeHash({ lens: 'orbit' })).toBe('#lens=orbit');
	});

	it('omits the default sky lens', () => {
		expect(encodeHash({ lens: 'sky' })).toBe('');
		expect(encodeHash({ view: { lat: 1, lon: 2, zoom: 3 }, lens: 'sky' })).toBe('#m=1,2,3');
	});

	it('decodes + validates the lens against the exact union', () => {
		expect(decodeHash('#lens=links').lens).toBe('links');
		expect(decodeHash('#lens=weather').lens).toBeUndefined();
		expect(decodeHash('#lens=Sky').lens).toBeUndefined(); // case-sensitive
	});

	it('round-trips a non-default lens alongside view/basemap', () => {
		const out = decodeHash('#m=42.44,-76.5,9&b=satellite&lens=air');
		expect(out.lens).toBe('air');
		expect(out.basemap).toBe('satellite');
		expect(out.view).toEqual({ lat: 42.44, lon: -76.5, zoom: 9 });
		expect(decodeHash(encodeHash(out)).lens).toBe('air');
	});
});
