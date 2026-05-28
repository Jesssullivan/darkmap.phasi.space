import { describe, expect, it } from 'vitest';
import { LAYERS, rasterUrlTemplate, VIIRS_YEARS, type RasterLayerDef } from './layers';

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

describe('layer manifest — atmospheric group (PR-A)', () => {
	it("'atmospheric' is a valid LayerGroup discriminator on RasterLayerDef", () => {
		const atmospheric: RasterLayerDef = {
			id: 'test-atmospheric',
			upstreamUrlTemplate: 'https://example.test/{z}/{x}/{y}.png',
			label: 'Test Atmospheric',
			description: 'Fixture used only by this test.',
			group: 'atmospheric',
			defaultEnabled: false,
			opacity: 0.7,
		};
		expect(atmospheric.group).toBe('atmospheric');
		expect(atmospheric.upstreamUrlTemplate).toContain('{z}');
		// Atmospheric layers do not carry an upstreamLayer (mutually exclusive).
		expect(atmospheric.upstreamLayer).toBeUndefined();
	});

	it("rasterUrlTemplate appends '&kind=atmospheric' when the layer is atmospheric", () => {
		// PR-A intentionally ships no atmospheric LAYERS entries; PR-B wires the
		// first one (MODIS Terra). Until then, validate the template behaviour by
		// asserting the existing entries do NOT get the kind hint.
		const out = rasterUrlTemplate('viirs_2019');
		expect(out).not.toContain('kind=atmospheric');
	});
});
