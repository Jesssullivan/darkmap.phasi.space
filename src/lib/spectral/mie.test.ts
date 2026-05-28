import { describe, expect, it } from 'vitest';
import { complex, mie, mieSpectrum } from './mie';

/**
 * Tests intentionally favor invariants and limiting cases over raw
 * reference-value tuples — atmospheric Mie outputs are exquisitely
 * sensitive to refractive-index conventions, and absolute-value cross-checks
 * are easier to do in V2-C against the V0 analytical aerosol LUT than to
 * cite from memory here. Bugs that survive these tests would still be
 * caught when the live-aerosol path is wired in V2-C.
 *
 * What this suite guards against:
 *   - Sign errors in the Riccati-Bessel recurrence
 *   - Truncation that's too tight (Q_ext fails to converge to 2 in the
 *     geometric limit)
 *   - Off-by-one in the Q_ext sum
 *   - Energy-conservation violations (Q_sca > Q_ext)
 *   - Asymmetry parameter escaping [-1, 1]
 */

describe('mie — geometric optics limit', () => {
	it('Q_ext → 2 as x → ∞ for a non-absorbing dielectric (extinction paradox)', () => {
		const result = mie(1000, complex(1.33, 1e-8));
		// 0.05 absolute tolerance — converges slowly but unambiguously.
		expect(result.qExt).toBeGreaterThan(1.95);
		expect(result.qExt).toBeLessThan(2.1);
		expect(result.qSca).toBeGreaterThan(1.95);
		expect(result.qSca).toBeLessThan(2.1);
	});

	it('absorbing sphere has Q_sca < Q_ext (energy conservation)', () => {
		const result = mie(50, complex(1.5, 0.5));
		expect(result.qSca).toBeLessThan(result.qExt);
		expect(result.qExt).toBeGreaterThan(1);
		expect(result.qExt).toBeLessThan(3);
	});

	it('non-absorbing sphere has Q_sca ≈ Q_ext (no absorption)', () => {
		for (const x of [1, 5, 10, 50]) {
			const result = mie(x, complex(1.33, 1e-8));
			expect(Math.abs(result.qSca - result.qExt)).toBeLessThan(1e-3);
		}
	});
});

describe('mie — Rayleigh limit (small x)', () => {
	it('Q_ext ≈ (8/3) x⁴ |(m²-1)/(m²+2)|² for x → 0 (non-absorbing)', () => {
		const x = 0.05;
		const m = complex(1.5, 0);
		const result = mie(x, m);
		const m2 = { re: m.re * m.re - m.im * m.im, im: 2 * m.re * m.im };
		const num = { re: m2.re - 1, im: m2.im };
		const den = { re: m2.re + 2, im: m2.im };
		const fracMod2 = (num.re * num.re + num.im * num.im) / (den.re * den.re + den.im * den.im);
		const expected = (8 / 3) * Math.pow(x, 4) * fracMod2;
		expect(result.qExt).toBeCloseTo(expected, 3);
	});

	it('Q_sca grows as x⁴ in the Rayleigh limit', () => {
		const m = complex(1.4, 0);
		const ratio = mie(0.1, m).qSca / mie(0.05, m).qSca;
		// (0.1/0.05)^4 = 16; allow ±10% for finite-x correction.
		expect(ratio).toBeGreaterThan(14);
		expect(ratio).toBeLessThan(18);
	});
});

describe('mie — asymmetry parameter', () => {
	it('g ≈ 0 in the Rayleigh limit (symmetric scattering)', () => {
		const result = mie(0.05, complex(1.5, 0));
		expect(Math.abs(result.g)).toBeLessThan(0.05);
	});

	it('g is positive and large for large dielectric spheres (forward scattering)', () => {
		const result = mie(100, complex(1.33, 1e-8));
		expect(result.g).toBeGreaterThan(0.8);
		expect(result.g).toBeLessThanOrEqual(1);
	});

	it('g stays in [-1, 1] across a range of x values', () => {
		for (const x of [0.1, 1, 5, 20, 100]) {
			const result = mie(x, complex(1.4, 0.05));
			expect(result.g).toBeGreaterThanOrEqual(-1);
			expect(result.g).toBeLessThanOrEqual(1);
		}
	});
});

describe('mie — input validation', () => {
	it('rejects non-positive x', () => {
		expect(() => mie(0, complex(1.5))).toThrow(/positive/);
		expect(() => mie(-1, complex(1.5))).toThrow(/positive/);
	});

	it('rejects non-finite refractive index', () => {
		expect(() => mie(1, complex(Number.NaN, 0))).toThrow();
		expect(() => mie(1, complex(0, 0))).toThrow();
	});
});

describe('mieSpectrum — wavelength sweep', () => {
	it('returns one Q_ext per wavelength', () => {
		const wavelengthsUm = [0.4, 0.55, 1.0, 2.0];
		const refractiveIndex = wavelengthsUm.map(() => complex(1.5, 0.01));
		const out = mieSpectrum({ radiusUm: 0.5, wavelengthsUm, refractiveIndex });
		expect(out.qExt).toHaveLength(wavelengthsUm.length);
		expect(out.wavelengthsUm).toBe(wavelengthsUm); // pass-through
	});

	it('Q_ext drops monotonically as λ grows (size parameter shrinks past geometric)', () => {
		const wavelengthsUm = [0.3, 0.4, 0.55, 0.8, 1.2, 2.0];
		const refractiveIndex = wavelengthsUm.map(() => complex(1.5, 0));
		const out = mieSpectrum({ radiusUm: 0.05, wavelengthsUm, refractiveIndex });
		// Small particle, Rayleigh-ish — Q_ext should decrease with λ.
		for (let i = 1; i < out.qExt.length; i++) {
			expect(out.qExt[i]).toBeLessThan(out.qExt[i - 1]);
		}
	});

	it('rejects mismatched array lengths', () => {
		expect(() => mieSpectrum({ radiusUm: 1, wavelengthsUm: [0.4, 0.5], refractiveIndex: [complex(1.5)] })).toThrow(
			/length/,
		);
	});
});
