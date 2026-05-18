import { describe, expect, it } from 'vitest';
import { airmassKastenYoung, formatAirmass } from './airmass';

describe('airmassKastenYoung', () => {
	it('is 1.0 at the zenith', () => {
		const X = airmassKastenYoung(90);
		expect(X).not.toBeNull();
		expect(X!).toBeCloseTo(1.0, 3);
	});

	it('is ~1.41 at altitude 45°', () => {
		// Pure sec(z) gives sec(45°) = 1.414. Kasten-Young agrees to ~4 dp at high alt.
		const X = airmassKastenYoung(45);
		expect(X).not.toBeNull();
		expect(X!).toBeCloseTo(1.414, 2);
	});

	it('is ~2.0 at altitude 30°', () => {
		const X = airmassKastenYoung(30);
		expect(X).not.toBeNull();
		expect(X!).toBeGreaterThan(1.99);
		expect(X!).toBeLessThan(2.02);
	});

	it('is ~5.6 at altitude 10° (curvature dominates over plane-parallel)', () => {
		const X = airmassKastenYoung(10);
		expect(X).not.toBeNull();
		// sec(80°) = 5.76; Kasten-Young is slightly smaller due to curvature.
		expect(X!).toBeGreaterThan(5);
		expect(X!).toBeLessThan(6);
	});

	it('grows monotonically as altitude decreases', () => {
		const samples = [85, 60, 45, 30, 20, 10, 5, 1];
		const xs = samples.map((a) => airmassKastenYoung(a));
		expect(xs.every((x) => x !== null)).toBe(true);
		for (let i = 1; i < xs.length; i++) {
			expect((xs[i] as number) > (xs[i - 1] as number)).toBe(true);
		}
	});

	it('returns null below the horizon', () => {
		expect(airmassKastenYoung(0)).toBeNull();
		expect(airmassKastenYoung(-5)).toBeNull();
		expect(airmassKastenYoung(-90)).toBeNull();
	});

	it('returns null for non-finite input', () => {
		expect(airmassKastenYoung(Number.NaN)).toBeNull();
		expect(airmassKastenYoung(Number.POSITIVE_INFINITY)).toBeNull();
	});
});

describe('formatAirmass', () => {
	it('renders — for null', () => {
		expect(formatAirmass(null)).toBe('—');
	});

	it('renders 2 decimals in the useful range', () => {
		expect(formatAirmass(1.414)).toBe('1.41');
		expect(formatAirmass(2.0)).toBe('2.00');
	});

	it('renders >10 above 10', () => {
		expect(formatAirmass(12.5)).toBe('>10');
		expect(formatAirmass(10)).toBe('>10');
	});
});
