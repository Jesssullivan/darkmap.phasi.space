import { describe, expect, it } from 'vitest';
import { aqiCategory, computeAqi, subIndexFor, toEpaUnit } from './aqi';

describe('subIndexFor — PM (µg/m³ direct)', () => {
	it('PM2.5 9.0 µg/m³ is the Good/Moderate boundary (50)', () => {
		expect(subIndexFor('pm25', 9.0, 'µg/m³')).toBe(50);
	});
	it('PM2.5 35.4 µg/m³ is the Moderate ceiling (100)', () => {
		expect(subIndexFor('pm25', 35.4, 'µg/m³')).toBe(100);
	});
	it('PM2.5 20.0 µg/m³ interpolates to 71', () => {
		expect(subIndexFor('pm25', 20.0, 'µg/m³')).toBe(71);
	});
	it('PM10 154 µg/m³ is the Moderate ceiling (100)', () => {
		expect(subIndexFor('pm10', 154, 'µg/m³')).toBe(100);
	});
	it('assumes µg/m³ for PM when units are missing', () => {
		expect(subIndexFor('pm25', 9.0, undefined)).toBe(50);
	});
	it('returns null above the top of the scale (off-scale, not clamped)', () => {
		expect(subIndexFor('pm25', 400, 'µg/m³')).toBeNull();
	});
});

describe('subIndexFor — gas unit conversion', () => {
	it('O₃ in ppm is used directly (0.085 ppm → 150)', () => {
		expect(subIndexFor('o3', 0.085, 'ppm')).toBe(150);
	});
	it('NO₂ 100 µg/m³ converts to ~53 ppb → 50', () => {
		expect(subIndexFor('no2', 100, 'µg/m³')).toBe(50);
	});
	it('CO 5 mg/m³ converts to ~4.36 ppm → 49', () => {
		expect(subIndexFor('co', 5, 'mg/m³')).toBe(49);
	});
	it('refuses to guess: unknown units for a gas → null (no fabricated index)', () => {
		expect(subIndexFor('no2', 100, 'parts-per-zorp')).toBeNull();
		expect(subIndexFor('o3', 0.05, undefined)).toBeNull();
	});
});

describe('toEpaUnit', () => {
	it('upconverts mg/m³ to µg/m³ for PM', () => {
		expect(toEpaUnit('pm25', 0.02, 'mg/m³')).toBeCloseTo(20, 6);
	});
	it('converts µg/m³ to ppb for NO₂ (24.45/46.01)', () => {
		expect(toEpaUnit('no2', 46.01, 'µg/m³')).toBeCloseTo(24.45, 2);
	});
	it('rejects negative / non-finite', () => {
		expect(toEpaUnit('pm25', -1, 'µg/m³')).toBeNull();
		expect(toEpaUnit('pm25', Number.NaN, 'µg/m³')).toBeNull();
	});
});

describe('aqiCategory', () => {
	it('maps index ranges to the right band', () => {
		expect(aqiCategory(0).name).toBe('Good');
		expect(aqiCategory(50).name).toBe('Good');
		expect(aqiCategory(75).name).toBe('Moderate');
		expect(aqiCategory(150).name).toBe('Unhealthy for sensitive groups');
		expect(aqiCategory(200).name).toBe('Unhealthy');
		expect(aqiCategory(300).name).toBe('Very unhealthy');
		expect(aqiCategory(420).name).toBe('Hazardous');
	});
});

describe('computeAqi', () => {
	it('is the max sub-index, with the dominant pollutant named', () => {
		const r = computeAqi([
			{ pollutant: 'pm25', value: 20.0, units: 'µg/m³' }, // 71
			{ pollutant: 'no2', value: 100, units: 'µg/m³' }, // 50
		]);
		expect(r).not.toBeNull();
		expect(r!.aqi).toBe(71);
		expect(r!.dominant).toBe('pm25');
		expect(r!.category.name).toBe('Moderate');
		expect(r!.subIndices).toMatchObject({ pm25: 71, no2: 50 });
	});

	it('skips pollutants that do not resolve (unknown units / off-scale)', () => {
		const r = computeAqi([
			{ pollutant: 'pm25', value: 9.0, units: 'µg/m³' }, // 50
			{ pollutant: 'o3', value: 0.05, units: undefined }, // null (unknown gas units)
		]);
		expect(r!.aqi).toBe(50);
		expect(r!.dominant).toBe('pm25');
		expect(r!.subIndices.o3).toBeUndefined();
	});

	it('returns null when nothing resolves', () => {
		expect(computeAqi([{ pollutant: 'no2', value: 5, units: undefined }])).toBeNull();
		expect(computeAqi([])).toBeNull();
	});
});
