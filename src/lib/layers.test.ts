import { describe, expect, it } from 'vitest';
import { LAYERS, rasterUrlTemplate, VIIRS_MONTHLY_END, VIIRS_MONTHLY_START, VIIRS_MONTHS, VIIRS_YEARS } from './layers';

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

describe('layer manifest — VIIRS monthly', () => {
	it('covers Apr 2012 through Apr 2026 (169 months)', () => {
		// Apr 2012 → Dec 2012 = 9 months, then 2013-2025 = 13×12 = 156, plus
		// Jan-Apr 2026 = 4 — total 169.
		expect(VIIRS_MONTHS).toHaveLength(169);
		expect(VIIRS_MONTHS[0]).toMatchObject({ year: 2012, month: 4 });
		expect(VIIRS_MONTHS[VIIRS_MONTHS.length - 1]).toMatchObject({ year: 2026, month: 4 });
	});

	it('sorts monthly layers chronologically ascending', () => {
		for (let i = 1; i < VIIRS_MONTHS.length; i++) {
			const prev = VIIRS_MONTHS[i - 1];
			const cur = VIIRS_MONTHS[i];
			const prevK = (prev.year ?? 0) * 12 + (prev.month ?? 0);
			const curK = (cur.year ?? 0) * 12 + (cur.month ?? 0);
			expect(curK).toBeGreaterThan(prevK);
		}
	});

	it('uses id pattern viirs_<year>_<MM> with zero-padded month', () => {
		const apr2012 = VIIRS_MONTHS[0];
		expect(apr2012.id).toBe('viirs_2012_04');
		const dec2015 = VIIRS_MONTHS.find((l) => l.year === 2015 && l.month === 12);
		expect(dec2015?.id).toBe('viirs_2015_12');
	});

	it('maps monthly ids to the lighttrends:viirs_npp_YYYYMM upstream layer', () => {
		expect(VIIRS_MONTHS[0].upstreamLayer).toBe('lighttrends:viirs_npp_201204');
		expect(VIIRS_MONTHS.find((l) => l.id === 'viirs_2020_07')?.upstreamLayer).toBe('lighttrends:viirs_npp_202007');
	});

	it('declares the canonical coverage window via VIIRS_MONTHLY_{START,END}', () => {
		expect(VIIRS_MONTHLY_START).toEqual({ year: 2012, month: 4 });
		expect(VIIRS_MONTHLY_END).toEqual({ year: 2026, month: 4 });
	});

	it('does not flag any monthly layer as defaultEnabled', () => {
		expect(VIIRS_MONTHS.every((l) => !l.defaultEnabled)).toBe(true);
	});
});

describe('layer manifest — composition', () => {
	it('LAYERS contains exactly the union of annual + monthly + 2 world atlas', () => {
		expect(LAYERS.length).toBe(VIIRS_YEARS.length + VIIRS_MONTHS.length + 2);
	});

	it('all ids are unique', () => {
		const ids = LAYERS.map((l) => l.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('rasterUrlTemplate roundtrips through the API proxy', () => {
		expect(rasterUrlTemplate('viirs_2019')).toBe('/api/raster?layer=viirs_2019&z={z}&x={x}&y={y}');
		expect(rasterUrlTemplate('viirs_2020_07')).toBe('/api/raster?layer=viirs_2020_07&z={z}&x={x}&y={y}');
	});
});
