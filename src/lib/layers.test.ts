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

	const PR_D_LAYERS: ReadonlyArray<{ id: string; tag: string }> = [
		{ id: 'clouds-viirs-noaa20', tag: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor' },
		{ id: 'aerosol-modis-aod', tag: 'MODIS_Combined_Value_Added_AOD' },
		{ id: 'water-vapor-airs', tag: 'AIRS_Precipitable_Water_Day' },
	];

	for (const { id, tag } of PR_D_LAYERS) {
		it(`${id} is registered with GIBS template + attribution`, () => {
			const def = LAYERS.find((l) => l.id === id);
			expect(def).toBeDefined();
			expect(def?.group).toBe('atmospheric');
			expect(def?.upstreamUrlTemplate).toContain(tag);
			expect(def?.upstreamUrlTemplate).toMatch(/\{z\}.+\{y\}.+\{x\}|\{z\}.+\{x\}.+\{y\}/s);
			expect(def?.upstreamUrlTemplate).toContain('{TIME}');
			expect(def?.attribution).toMatch(/NASA EOSDIS GIBS/);
			expect(def?.upstreamLayer).toBeUndefined();
			expect(def?.defaultEnabled).toBe(false);
		});
	}

	it('OpenAQ PM2.5 smog overlay (PR-F) is a point-source layer', () => {
		const smog = LAYERS.find((l) => l.id === 'smog-openaq-pm25');
		expect(smog).toBeDefined();
		expect(smog?.group).toBe('atmospheric');
		expect(smog?.pointSourceUrl).toBe('/api/atmospheric/openaq');
		expect(smog?.upstreamUrlTemplate).toBeUndefined();
		expect(smog?.upstreamLayer).toBeUndefined();
		expect(smog?.attribution).toMatch(/OpenAQ/i);
	});
});
