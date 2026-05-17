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
});
