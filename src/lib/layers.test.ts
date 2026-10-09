import { describe, expect, it } from 'vitest';
import {
	generateViirsMonthlyKeys,
	LAYERS,
	rasterUrlTemplate,
	utcDayKey,
	VIIRS_MONTHLY_LAYERS,
	VIIRS_YEARS,
	type RasterLayerDef,
} from './layers';

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

describe('layer manifest — VIIRS monthly (TIN-1301 subtask 1)', () => {
	// 169, not the epic's headline "178" — see the NOTE above VIIRS_MONTHLY_START
	// in layers.ts. 2012-04 through 2026-04 inclusive is 169 months; the epic
	// text's own date range and headline count disagree, and this manifest
	// follows the checkable range rather than fabricating layer ids past it.
	it('exposes exactly 169 monthly layers, 2012-04 through 2026-04 inclusive', () => {
		expect(LAYERS.filter((l) => l.group === 'viirs_monthly')).toHaveLength(169);
		expect(VIIRS_MONTHLY_LAYERS).toHaveLength(169);
	});

	it('generateViirsMonthlyKeys is chronological, starts 2012-04, ends 2026-04, no gaps/dupes', () => {
		const keys = generateViirsMonthlyKeys();
		expect(keys).toHaveLength(169);
		expect(keys[0]).toBe('2012-04');
		expect(keys.at(-1)).toBe('2026-04');
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys).toEqual([...keys].sort());
		// No calendar gaps: consecutive keys are always exactly one month apart.
		for (let i = 1; i < keys.length; i++) {
			const [py, pm] = keys[i - 1].split('-').map(Number);
			const [cy, cm] = keys[i].split('-').map(Number);
			const prevOrdinal = py * 12 + pm;
			const curOrdinal = cy * 12 + cm;
			expect(curOrdinal - prevOrdinal).toBe(1);
		}
	});

	it('maps monthly ids to lighttrends:viirs_npp_YYYYMM and carries a month key', () => {
		const july2019 = LAYERS.find((l) => l.id === 'viirs_201907');
		expect(july2019).toBeDefined();
		expect(july2019?.group).toBe('viirs_monthly');
		expect(july2019?.upstreamLayer).toBe('lighttrends:viirs_npp_201907');
		expect(july2019?.month).toBe('2019-07');
	});

	it('rasterUrlTemplate proxies a monthly layer like any other GeoServer layer (no atmospheric kind hint)', () => {
		const url = rasterUrlTemplate('viirs_201907');
		expect(url).toBe('/api/raster?layer=viirs_201907&z={z}&x={x}&y={y}');
		expect(url).not.toContain('kind=atmospheric');
	});

	it('none of the 178 monthly layers are on by default — only reachable via TimeDock', () => {
		expect(VIIRS_MONTHLY_LAYERS.every((l) => l.defaultEnabled === false)).toBe(true);
	});
});

describe('layer manifest — composition', () => {
	it('LAYERS contains the VIIRS annual + monthly union + styled world atlas + atmospheric overlays', () => {
		const worldAtlas = LAYERS.filter((l) => l.group === 'world_atlas').length;
		const atmospheric = LAYERS.filter((l) => l.group === 'atmospheric').length;
		// One styled World Atlas overlay; the raw radiance grid is point-query-only (#247).
		expect(worldAtlas).toBe(1);
		expect(LAYERS.length).toBe(VIIRS_YEARS.length + VIIRS_MONTHLY_LAYERS.length + worldAtlas + atmospheric);
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

	it('rasterUrlTemplate appends an explicit atmospheric UTC day when provided', () => {
		expect(rasterUrlTemplate('clouds-modis-terra', { time: new Date('2026-05-28T23:50:00Z') })).toBe(
			'/api/raster?layer=clouds-modis-terra&z={z}&x={x}&y={y}&kind=atmospheric&time=2026-05-28',
		);
	});

	it("rasterUrlTemplate omits the 'kind' hint for non-atmospheric layers", () => {
		expect(rasterUrlTemplate('viirs_2019')).not.toContain('kind=atmospheric');
		expect(rasterUrlTemplate('viirs_2019', { time: '2026-05-28' })).not.toContain('time=');
	});

	it('utcDayKey is stable across local timezone offsets', () => {
		expect(utcDayKey(new Date('2026-05-29T00:30:00+02:00'))).toBe('2026-05-28');
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
		{ id: 'water-vapor-airs', tag: 'MODIS_Terra_Water_Vapor_5km_Day' },
	];

	it('records native GIBS matrix depth so MapLibre overzooms instead of requesting unsupported tiles', () => {
		const caps = Object.fromEntries(
			LAYERS.filter((l) => l.group === 'atmospheric' && l.upstreamUrlTemplate).map((l) => [l.id, l.maxNativeZoom]),
		);
		expect(caps).toEqual({
			'aerosol-modis-aod': 6,
			'clouds-modis-terra': 9,
			'clouds-viirs-noaa20': 9,
			'water-vapor-airs': 6,
		});

		for (const def of LAYERS.filter((l) => l.group === 'atmospheric' && l.upstreamUrlTemplate)) {
			expect(def.upstreamUrlTemplate).toContain(`GoogleMapsCompatible_Level${def.maxNativeZoom}`);
		}
	});

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
		expect(smog?.maxNativeZoom).toBeUndefined();
		expect(smog?.attribution).toMatch(/OpenAQ/i);
	});
});
