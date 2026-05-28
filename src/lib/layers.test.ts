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
	it('LAYERS contains the VIIRS annual union + world atlas pair + atmospheric overlays', () => {
		const atmospheric = LAYERS.filter((l) => l.group === 'atmospheric').length;
		expect(LAYERS.length).toBe(VIIRS_YEARS.length + 2 + atmospheric);
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
		expect(rasterUrlTemplate('clouds-modis-terra')).toBe(
			'/api/raster?layer=clouds-modis-terra&z={z}&x={x}&y={y}&kind=atmospheric',
		);
	});

	it("rasterUrlTemplate omits the 'kind' hint for non-atmospheric layers", () => {
		expect(rasterUrlTemplate('viirs_2019')).not.toContain('kind=atmospheric');
	});

	it('MODIS Terra clouds entry exists with GIBS WMTS template + NASA EOSDIS attribution', () => {
		const modis = LAYERS.find((l) => l.id === 'clouds-modis-terra');
		expect(modis).toBeDefined();
		expect(modis?.group).toBe('atmospheric');
		expect(modis?.upstreamUrlTemplate).toContain('MODIS_Terra_CorrectedReflectance_TrueColor');
		expect(modis?.upstreamUrlTemplate).toContain('{TIME}');
		expect(modis?.upstreamUrlTemplate).toContain('{z}');
		expect(modis?.upstreamUrlTemplate).toContain('{x}');
		expect(modis?.upstreamUrlTemplate).toContain('{y}');
		expect(modis?.attribution).toMatch(/NASA EOSDIS GIBS/);
		// Atmospheric entries don't carry a GeoServer counterpart.
		expect(modis?.upstreamLayer).toBeUndefined();
	});
});
