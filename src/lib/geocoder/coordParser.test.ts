import { describe, expect, it } from 'vitest';
import { dispatchSearchInput, parseCoordinates } from './coordParser';

describe('parseCoordinates — decimal', () => {
	it('parses comma-separated decimal lat/lon', () => {
		expect(parseCoordinates('42.4434, -76.5019')).toEqual({
			lat: 42.4434,
			lon: -76.5019,
			format: 'decimal',
		});
	});

	it('parses space-separated decimal lat/lon', () => {
		expect(parseCoordinates('42.4434 -76.5019')).toEqual({
			lat: 42.4434,
			lon: -76.5019,
			format: 'decimal',
		});
	});

	it('handles integer lat/lon', () => {
		expect(parseCoordinates('0 0')).toEqual({ lat: 0, lon: 0, format: 'decimal' });
	});

	it('rejects out-of-range latitude', () => {
		expect(parseCoordinates('91, 0')).toBeNull();
		expect(parseCoordinates('-91, 0')).toBeNull();
	});

	it('rejects out-of-range longitude', () => {
		expect(parseCoordinates('0, 181')).toBeNull();
		expect(parseCoordinates('0, -181')).toBeNull();
	});

	it('rejects non-coordinate text', () => {
		expect(parseCoordinates('Ithaca')).toBeNull();
		expect(parseCoordinates('foo, bar')).toBeNull();
	});
});

describe('parseCoordinates — DMS', () => {
	it('parses 42°26\'36"N 76°30\'07"W', () => {
		const r = parseCoordinates(`42°26'36"N 76°30'07"W`);
		expect(r?.format).toBe('dms');
		expect(r?.lat).toBeCloseTo(42.4433, 3);
		expect(r?.lon).toBeCloseTo(-76.5019, 3);
	});

	it('parses southern + eastern hemispheres', () => {
		const r = parseCoordinates(`33°51'35"S 151°12'34"E`);
		expect(r?.lat).toBeCloseTo(-33.8597, 3);
		expect(r?.lon).toBeCloseTo(151.2094, 3);
	});

	it('accepts unicode prime ′ and double-prime ″', () => {
		const r = parseCoordinates(`42°26′36″N 76°30′07″W`);
		expect(r?.lat).toBeCloseTo(42.4433, 3);
	});

	it('handles fractional seconds', () => {
		const r = parseCoordinates(`42°26'36.5"N 76°30'07.25"W`);
		expect(r?.lat).toBeCloseTo(42.4435, 3);
	});
});

describe('parseCoordinates — DMM (degrees-decimal-minutes)', () => {
	it("parses 42°26.6'N 76°30.115'W", () => {
		const r = parseCoordinates(`42°26.6'N 76°30.115'W`);
		expect(r?.format).toBe('dmm');
		expect(r?.lat).toBeCloseTo(42.4433, 3);
		expect(r?.lon).toBeCloseTo(-76.5019, 3);
	});

	it('rejects DMS when no seconds part follows', () => {
		// 26.6 without a seconds token is DMM, not malformed DMS.
		const r = parseCoordinates(`42°26.6'N 76°30.115'W`);
		expect(r?.format).toBe('dmm');
	});
});

describe('dispatchSearchInput', () => {
	it('returns coord for a parseable input', () => {
		const r = dispatchSearchInput('42.4434, -76.5019');
		expect(r.kind).toBe('coord');
		if (r.kind === 'coord') {
			expect(r.coord.lat).toBe(42.4434);
		}
	});

	it('returns query for free text', () => {
		const r = dispatchSearchInput('Cherry Springs State Park');
		expect(r.kind).toBe('query');
		if (r.kind === 'query') expect(r.q).toBe('Cherry Springs State Park');
	});

	it('returns empty for whitespace', () => {
		expect(dispatchSearchInput('').kind).toBe('empty');
		expect(dispatchSearchInput('   ').kind).toBe('empty');
	});

	it('strips outer whitespace before trying both branches', () => {
		const r = dispatchSearchInput('   Ithaca   ');
		expect(r.kind).toBe('query');
		if (r.kind === 'query') expect(r.q).toBe('Ithaca');
	});
});
