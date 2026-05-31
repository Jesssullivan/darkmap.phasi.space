import { describe, expect, it } from 'vitest';
import {
	ATMOSPHERIC_CAPABILITIES,
	capabilityFor,
	defaultTimeForCapability,
	expandAtmosphericUrl,
	isAtmosphericLayer,
	isImmutableTime,
} from './atmospheric-capabilities';
import { LAYERS } from './layers';

describe('ATMOSPHERIC_CAPABILITIES table', () => {
	it('has an entry for every atmospheric-group LAYERS member', () => {
		const atmospheric = LAYERS.filter((l) => l.group === 'atmospheric' && l.upstreamUrlTemplate);
		for (const layer of atmospheric) {
			expect(capabilityFor(layer.id)).toBeDefined();
		}
	});

	for (const [id, cap] of Object.entries(ATMOSPHERIC_CAPABILITIES)) {
		it(`${id}: capability values are physically sensible`, () => {
			expect(cap.maxNativeZoom).toBeGreaterThanOrEqual(0);
			expect(cap.maxNativeZoom).toBeLessThan(15);
			expect(['daily', 'static']).toContain(cap.dateCadence);
			expect(cap.publicationLagHours).toBeGreaterThanOrEqual(0);
			expect(cap.publicationLagHours).toBeLessThanOrEqual(48);
		});
	}
});

describe('defaultTimeForCapability', () => {
	const cap = { maxNativeZoom: 9, dateCadence: 'daily', publicationLagHours: 6 } as const;

	it('returns today when current UTC hour is past the lag threshold', () => {
		const now = new Date('2026-05-28T12:00:00Z'); // 12:00 UTC > 6h lag
		expect(defaultTimeForCapability(cap, now)).toBe('2026-05-28');
	});

	it('returns yesterday when current UTC hour is before the lag threshold', () => {
		const now = new Date('2026-05-28T03:00:00Z'); // 03:00 UTC < 6h lag
		expect(defaultTimeForCapability(cap, now)).toBe('2026-05-27');
	});

	it('respects per-layer lag — AIRS PWAT (lag=20h) steps back at 18:00 UTC', () => {
		const airs = capabilityFor('water-vapor-airs')!;
		const eveningPublish = new Date('2026-05-28T18:00:00Z');
		expect(defaultTimeForCapability(airs, eveningPublish)).toBe('2026-05-27');
		const lateNight = new Date('2026-05-28T22:00:00Z');
		expect(defaultTimeForCapability(airs, lateNight)).toBe('2026-05-28');
	});

	it('static cadence returns the literal "default" keyword', () => {
		const staticCap = { maxNativeZoom: 6, dateCadence: 'static', publicationLagHours: 0 } as const;
		expect(defaultTimeForCapability(staticCap, new Date())).toBe('default');
	});
});

describe('isImmutableTime', () => {
	it('freezes tiles dated > 48h ago', () => {
		const now = new Date('2026-05-28T12:00:00Z');
		expect(isImmutableTime('2026-05-25', now)).toBe(true);
		expect(isImmutableTime('2020-01-01', now)).toBe(true);
	});

	it('keeps recent tiles fresh', () => {
		const now = new Date('2026-05-28T12:00:00Z');
		expect(isImmutableTime('2026-05-27', now)).toBe(false);
		expect(isImmutableTime('2026-05-28', now)).toBe(false);
	});

	it('treats the "default" keyword as never immutable', () => {
		expect(isImmutableTime('default', new Date())).toBe(false);
	});

	it('rejects unparseable strings (no false-positive immutability)', () => {
		expect(isImmutableTime('not-a-date', new Date())).toBe(false);
	});
});

describe('expandAtmosphericUrl', () => {
	it('substitutes all four template slots', () => {
		const template = 'https://gibs.earthdata.nasa.gov/wmts/best/MODIS/default/{TIME}/Level{z}/{z}/{y}/{x}.jpg';
		expect(expandAtmosphericUrl(template, 5, 12, 9, '2026-05-28')).toBe(
			'https://gibs.earthdata.nasa.gov/wmts/best/MODIS/default/2026-05-28/Level5/5/9/12.jpg',
		);
	});
});

describe('isAtmosphericLayer type guard', () => {
	it('returns true for atmospheric-group layers with upstreamUrlTemplate', () => {
		const modis = LAYERS.find((l) => l.id === 'clouds-modis-terra')!;
		expect(isAtmosphericLayer(modis)).toBe(true);
	});

	it('returns false for non-atmospheric layers', () => {
		const viirs = LAYERS.find((l) => l.group === 'viirs_annual')!;
		expect(isAtmosphericLayer(viirs)).toBe(false);
	});
});
