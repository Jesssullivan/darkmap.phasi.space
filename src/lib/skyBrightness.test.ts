import { describe, expect, it } from 'vitest';
import { bortleFromArtificialMcd, bortleFromSqm, NATURAL_SKY_MCD, sqmFromArtificialMcd } from './skyBrightness';

describe('sqmFromArtificialMcd', () => {
	it('returns ~22.0 mag/arcsec² for a pristine sky (no artificial light)', () => {
		expect(sqmFromArtificialMcd(0)).toBeCloseTo(22.0, 1);
	});

	it('floors negative artificial input at the natural sky', () => {
		expect(sqmFromArtificialMcd(-5)).toBeCloseTo(sqmFromArtificialMcd(0), 6);
	});

	it('is monotonically decreasing — more artificial light ⇒ a brighter (lower) SQM', () => {
		expect(sqmFromArtificialMcd(0.08)).toBeGreaterThan(sqmFromArtificialMcd(1));
		expect(sqmFromArtificialMcd(1)).toBeGreaterThan(sqmFromArtificialMcd(100));
	});

	it('matches the canonical natural-sky constant', () => {
		expect(NATURAL_SKY_MCD).toBeCloseTo(0.171, 3);
	});
});

describe('bortleFromSqm', () => {
	it('maps the dark end to Bortle 1 and the bright end to Bortle 9', () => {
		expect(bortleFromSqm(22.0).cls).toBe(1);
		expect(bortleFromSqm(15.0).cls).toBe(9);
	});

	it('walks the consensus bands in order', () => {
		expect(bortleFromSqm(21.9).cls).toBe(2);
		expect(bortleFromSqm(21.7).cls).toBe(3);
		expect(bortleFromSqm(21.3).cls).toBe(4);
		expect(bortleFromSqm(20.5).cls).toBe(5);
		expect(bortleFromSqm(19.6).cls).toBe(6);
		expect(bortleFromSqm(18.95).cls).toBe(7);
		expect(bortleFromSqm(18.5).cls).toBe(8);
	});

	it('class never escapes 1..9', () => {
		for (const s of [30, 22, 20, 18, 10, -5]) {
			const { cls } = bortleFromSqm(s);
			expect(cls).toBeGreaterThanOrEqual(1);
			expect(cls).toBeLessThanOrEqual(9);
		}
	});
});

describe('bortleFromArtificialMcd', () => {
	it('a pristine site reads Bortle 1 with SQM ~22', () => {
		const r = bortleFromArtificialMcd(0);
		expect(r.cls).toBe(1);
		expect(r.sqm).toBeCloseTo(22.0, 1);
		expect(r.label).toMatch(/dark/i);
	});

	it('the smoke fixture (0.08 mcd/m²) reads a rural-class sky', () => {
		const r = bortleFromArtificialMcd(0.08);
		expect(r.cls).toBeGreaterThanOrEqual(2);
		expect(r.cls).toBeLessThanOrEqual(4);
		expect(r.sqm).toBeGreaterThan(21);
	});

	it('a bright urban pixel reads a high Bortle class', () => {
		expect(bortleFromArtificialMcd(100).cls).toBeGreaterThanOrEqual(8);
	});
});
