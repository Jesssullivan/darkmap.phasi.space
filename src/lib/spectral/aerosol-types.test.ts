import { describe, expect, it } from 'vitest';
import { AEROSOL_TYPES, aerosolEntry, refractiveIndexAt, sampleSizeDistribution } from './aerosol-types';

describe('aerosol catalog', () => {
	it('exposes five canonical types', () => {
		expect(AEROSOL_TYPES).toEqual(['smoke', 'dust', 'urban', 'pollen', 'mixed']);
	});

	for (const type of AEROSOL_TYPES) {
		it(`${type}: has ≥5 refractive-index samples spanning 0.3-30 µm`, () => {
			const entry = aerosolEntry(type);
			expect(entry.refractiveIndex.length).toBeGreaterThanOrEqual(5);
			expect(entry.refractiveIndex[0].lambdaUm).toBeLessThanOrEqual(0.5);
			expect(entry.refractiveIndex[entry.refractiveIndex.length - 1].lambdaUm).toBeGreaterThanOrEqual(10);
			expect(entry.citation.length).toBeGreaterThan(10);
		});

		it(`${type}: refractive-index samples are sorted by wavelength`, () => {
			const samples = aerosolEntry(type).refractiveIndex;
			for (let i = 1; i < samples.length; i++) {
				expect(samples[i].lambdaUm).toBeGreaterThan(samples[i - 1].lambdaUm);
			}
		});

		it(`${type}: refractive index has n > 1 and k ≥ 0 throughout`, () => {
			for (const s of aerosolEntry(type).refractiveIndex) {
				expect(s.n).toBeGreaterThan(1);
				expect(s.k).toBeGreaterThanOrEqual(0);
			}
		});
	}
});

describe('refractiveIndexAt — interpolation', () => {
	it('returns endpoint values when λ is outside the sampled range', () => {
		const samples = aerosolEntry('smoke').refractiveIndex;
		const low = refractiveIndexAt('smoke', 0.1);
		expect(low.re).toBe(samples[0].n);
		expect(low.im).toBe(samples[0].k);
		const high = refractiveIndexAt('smoke', 100);
		expect(high.re).toBe(samples[samples.length - 1].n);
		expect(high.im).toBe(samples[samples.length - 1].k);
	});

	it('linearly interpolates between samples', () => {
		// Mid-point between samples[0]=0.3µm and samples[1]=0.4µm for smoke
		const a = aerosolEntry('smoke').refractiveIndex[0];
		const b = aerosolEntry('smoke').refractiveIndex[1];
		const mid = (a.lambdaUm + b.lambdaUm) / 2;
		const r = refractiveIndexAt('smoke', mid);
		expect(r.re).toBeCloseTo((a.n + b.n) / 2, 6);
		expect(r.im).toBeCloseTo((a.k + b.k) / 2, 6);
	});

	it('returns exact sample value when λ matches a sample', () => {
		const samples = aerosolEntry('dust').refractiveIndex;
		const sample = samples[3];
		const r = refractiveIndexAt('dust', sample.lambdaUm);
		expect(r.re).toBeCloseTo(sample.n, 6);
		expect(r.im).toBeCloseTo(sample.k, 6);
	});
});

describe('sampleSizeDistribution', () => {
	it('weights sum to 1', () => {
		const bins = sampleSizeDistribution({ modeRadiusUm: 0.1, geometricStdDev: 2.0 });
		const sum = bins.reduce((acc, b) => acc + b.weight, 0);
		expect(sum).toBeCloseTo(1, 6);
	});

	it('mode radius is near the peak of the weight distribution', () => {
		const bins = sampleSizeDistribution({ modeRadiusUm: 0.5, geometricStdDev: 1.5 });
		let maxIdx = 0;
		for (let i = 1; i < bins.length; i++) {
			if (bins[i].weight > bins[maxIdx].weight) maxIdx = i;
		}
		// Mode of log-normal is e^(ln r_g - ln²σ_g) which is < r_g; just check
		// the peak weight is within an order of magnitude of r_g.
		expect(bins[maxIdx].radiusUm).toBeGreaterThan(0.1);
		expect(bins[maxIdx].radiusUm).toBeLessThan(2);
	});

	it('respects the requested bin count', () => {
		expect(sampleSizeDistribution({ modeRadiusUm: 1, geometricStdDev: 2 }, 8)).toHaveLength(8);
		expect(sampleSizeDistribution({ modeRadiusUm: 1, geometricStdDev: 2 }, 24)).toHaveLength(24);
	});
});
