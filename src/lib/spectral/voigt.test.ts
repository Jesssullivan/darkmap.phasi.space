import { describe, expect, it } from 'vitest';
import { dopplerHwhm, pressureHwhm, voigtProfile } from './voigt';

const SQRT_LN2_OVER_PI = Math.sqrt(Math.LN2 / Math.PI);

describe('voigtProfile — limiting cases', () => {
	it('reduces to a pure Gaussian when α_L → 0', () => {
		const alphaD = 0.05;
		const x = 0.02;
		const result = voigtProfile(x, alphaD, 0);
		const gaussian = (SQRT_LN2_OVER_PI / alphaD) * Math.exp(-Math.LN2 * (x / alphaD) ** 2);
		expect(result).toBeCloseTo(gaussian, 4);
	});

	it('reduces to a pure Lorentzian when α_D → 0', () => {
		const alphaL = 0.05;
		const x = 0.02;
		const result = voigtProfile(x, 0, alphaL);
		const lorentzian = alphaL / Math.PI / (x * x + alphaL * alphaL);
		expect(result).toBeCloseTo(lorentzian, 4);
	});

	it('is unimodal with peak at δν = 0', () => {
		const alphaD = 0.03;
		const alphaL = 0.04;
		const peak = voigtProfile(0, alphaD, alphaL);
		expect(voigtProfile(0.05, alphaD, alphaL)).toBeLessThan(peak);
		expect(voigtProfile(-0.05, alphaD, alphaL)).toBeLessThan(peak);
		expect(voigtProfile(0.5, alphaD, alphaL)).toBeLessThan(voigtProfile(0.05, alphaD, alphaL));
	});

	it('is symmetric: V(δν) = V(-δν)', () => {
		const alphaD = 0.04;
		const alphaL = 0.03;
		for (const x of [0.01, 0.05, 0.1, 0.5]) {
			expect(voigtProfile(x, alphaD, alphaL)).toBeCloseTo(voigtProfile(-x, alphaD, alphaL), 10);
		}
	});

	it('approximately normalized: ∫ V(δν) dδν ≈ 1', () => {
		const alphaD = 0.05;
		const alphaL = 0.04;
		// Trapezoidal numerical integration on a dense grid out to ±20 HWHM.
		const grid: number[] = [];
		for (let x = -2.0; x <= 2.0; x += 0.001) grid.push(x);
		let integral = 0;
		for (let i = 1; i < grid.length; i++) {
			const dx = grid[i] - grid[i - 1];
			const v1 = voigtProfile(grid[i - 1], alphaD, alphaL);
			const v2 = voigtProfile(grid[i], alphaD, alphaL);
			integral += 0.5 * (v1 + v2) * dx;
		}
		// Pseudo-Voigt approximation isn't perfectly normalized but stays within 5%.
		expect(integral).toBeGreaterThan(0.95);
		expect(integral).toBeLessThan(1.05);
	});
});

describe('voigtProfile — input validation', () => {
	it('rejects negative HWHMs', () => {
		expect(() => voigtProfile(0, -0.01, 0.01)).toThrow();
		expect(() => voigtProfile(0, 0.01, -0.01)).toThrow();
	});
});

describe('dopplerHwhm — temperature scaling', () => {
	it('grows with sqrt(T)', () => {
		const at300 = dopplerHwhm(10_000, 300, 18);
		const at600 = dopplerHwhm(10_000, 600, 18);
		expect(at600 / at300).toBeCloseTo(Math.sqrt(2), 3);
	});

	it('is proportional to ν₀', () => {
		const a = dopplerHwhm(10_000, 296, 18);
		const b = dopplerHwhm(5_000, 296, 18);
		expect(a / b).toBeCloseTo(2, 6);
	});

	it('for water vapor at 296 K, line at 10,000 cm⁻¹, αD ~ 0.01 cm⁻¹', () => {
		const result = dopplerHwhm(10_000, 296, 18);
		expect(result).toBeGreaterThan(0.005);
		expect(result).toBeLessThan(0.02);
	});
});

describe('pressureHwhm — pressure and temperature scaling', () => {
	it('halves when pressure halves', () => {
		const ref = pressureHwhm(0.1, 1.0, 296, 0.7);
		const half = pressureHwhm(0.1, 0.5, 296, 0.7);
		expect(half / ref).toBeCloseTo(0.5, 6);
	});

	it('falls with temperature^n', () => {
		const cold = pressureHwhm(0.1, 1.0, 200, 0.7);
		const hot = pressureHwhm(0.1, 1.0, 296, 0.7);
		// At cold T, broadening is larger.
		expect(cold).toBeGreaterThan(hot);
	});
});
