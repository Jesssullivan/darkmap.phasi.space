import { describe, expect, it } from 'vitest';
import { ZENITH } from './slant-geometry';
import { type BodyPositions, resolveLookAngle } from './look-angle';

const bodies = (sunAlt: number, sunAz: number, moonAlt = 20, moonAz = 200): BodyPositions => ({
	sun: { altitudeDeg: sunAlt, azimuthDeg: sunAz },
	moon: { altitudeDeg: moonAlt, azimuthDeg: moonAz },
});

describe('resolveLookAngle', () => {
	it('zenith target returns straight up regardless of bodies', () => {
		const r = resolveLookAngle('zenith', { azimuthDeg: 42, elevationDeg: 12 }, bodies(45, 180));
		expect(r.kind).toBe('ok');
		expect(r.lookAngle).toEqual(ZENITH);
	});

	it('manual target echoes the dialed angle', () => {
		const manual = { azimuthDeg: 123, elevationDeg: 34 };
		const r = resolveLookAngle('manual', manual, bodies(45, 180));
		expect(r.kind).toBe('ok');
		expect(r.lookAngle).toEqual(manual);
	});

	it('sun target maps the sun alt-az when above the horizon', () => {
		const r = resolveLookAngle('sun', ZENITH, bodies(30, 135));
		expect(r.kind).toBe('ok');
		expect(r.lookAngle).toEqual({ azimuthDeg: 135, elevationDeg: 30 });
	});

	it('moon target maps the moon alt-az', () => {
		const r = resolveLookAngle('moon', ZENITH, bodies(30, 135, 25, 210));
		expect(r.kind).toBe('ok');
		expect(r.lookAngle).toEqual({ azimuthDeg: 210, elevationDeg: 25 });
	});

	it('normalizes a negative ephemeris azimuth', () => {
		const r = resolveLookAngle('sun', ZENITH, bodies(10, -45));
		expect(r.lookAngle.azimuthDeg).toBe(315);
	});

	it('reports below-horizon when the sun is down', () => {
		const r = resolveLookAngle('sun', ZENITH, bodies(-3, 280));
		expect(r.kind).toBe('below-horizon');
		if (r.kind === 'below-horizon') {
			expect(r.body).toBe('sun');
			expect(r.lookAngle.elevationDeg).toBe(-3);
		}
	});

	it('falls back to the manual angle when ephemeris has not resolved', () => {
		const manual = { azimuthDeg: 77, elevationDeg: 55 };
		const r = resolveLookAngle('sun', manual, null);
		expect(r.kind).toBe('ok');
		expect(r.lookAngle).toEqual(manual);
	});
});
