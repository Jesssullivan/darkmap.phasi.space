import { describe, expect, it } from 'vitest';
import { LAYERS, rasterUrlTemplate, VIIRS_YEARS } from './layers';

describe('layer manifest — VIIRS annual', () => {
	it('exposes 8 VIIRS annual layers (2012-2019)', () => {
		expect(VIIRS_YEARS).toHaveLength(8);
		const years = VIIRS_YEARS.map((l) => l.year);
		expect(years).toEqual([2019, 2018, 2017, 2016, 2015, 2014, 2013, 2012]);
	});

	it('maps annual ids to PostGIS:VIIRS_<year>', () => {
		expect(VIIRS_YEARS.find((l) => l.id === 'viirs_2019')?.upstreamLayer).toBe('PostGIS:VIIRS_2019');
	});
});

describe('layer manifest — composition', () => {
	it('LAYERS contains exactly the union of annual + 2 world atlas', () => {
		expect(LAYERS.length).toBe(VIIRS_YEARS.length + 2);
	});

	it('all ids are unique', () => {
		const ids = LAYERS.map((l) => l.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('rasterUrlTemplate roundtrips through the API proxy', () => {
		expect(rasterUrlTemplate('viirs_2019')).toBe('/api/raster?layer=viirs_2019&z={z}&x={x}&y={y}');
	});
});
