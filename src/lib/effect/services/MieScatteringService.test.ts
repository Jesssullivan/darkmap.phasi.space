import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { AEROSOL_TYPES } from '$lib/spectral/aerosol-types';
import { makeMieScatteringServiceLive, MieScatteringService } from './MieScatteringService';

const WAVELENGTHS = [0.4, 0.55, 0.7, 1.0, 1.6, 2.0, 5.0, 10.0];

const runCompute = (aerosolType: import('$lib/spectral/aerosol-types').AerosolType, aod550: number) =>
	Effect.runPromiseExit(
		Effect.gen(function* () {
			const svc = yield* MieScatteringService;
			return yield* svc.compute({ aerosolType, aod550 }, WAVELENGTHS);
		}).pipe(Effect.provide(makeMieScatteringServiceLive())),
	);

describe('MieScatteringService — calibration', () => {
	for (const type of AEROSOL_TYPES) {
		it(`${type}: tau at the 550 nm wavelength index equals AOD550`, async () => {
			const exit = await runCompute(type, 0.5);
			if (exit._tag !== 'Success') throw new Error('expected Success');
			const idx550 = WAVELENGTHS.indexOf(0.55);
			expect(exit.value.tau[idx550]).toBeCloseTo(0.5, 6);
		});
	}

	it('scales linearly with AOD550 input', async () => {
		const lo = await runCompute('smoke', 0.1);
		const hi = await runCompute('smoke', 0.5);
		if (lo._tag !== 'Success' || hi._tag !== 'Success') throw new Error('expected Success');
		for (let i = 0; i < WAVELENGTHS.length; i++) {
			expect(hi.value.tau[i] / lo.value.tau[i]).toBeCloseTo(5, 6);
		}
	});

	it('AOD550=0 produces tau≈0 across the spectrum', async () => {
		const exit = await runCompute('smoke', 0);
		if (exit._tag !== 'Success') throw new Error('expected Success');
		for (const t of exit.value.tau) {
			expect(t).toBeCloseTo(0, 6);
		}
	});
});

describe('MieScatteringService — spectral shape sanity', () => {
	it('smoke (fine-mode, high α) drops tau toward the SWIR', async () => {
		const exit = await runCompute('smoke', 0.3);
		if (exit._tag !== 'Success') throw new Error('expected Success');
		const tau = exit.value.tau;
		// Smoke α ~2 — tau at 1.6 µm should be much less than at 0.55 µm.
		expect(tau[4]).toBeLessThan(tau[1]);
	});

	it('dust spectral shape is much flatter than smoke (coarse-mode signature)', async () => {
		const dustExit = await runCompute('dust', 0.3);
		const smokeExit = await runCompute('smoke', 0.3);
		if (dustExit._tag !== 'Success' || smokeExit._tag !== 'Success') {
			throw new Error('expected Success');
		}
		// Compare 0.55 µm / 1.6 µm ratios. Smoke (fine, high α) should have a
		// much larger ratio than dust (coarse, near-zero or negative α).
		const dustRatio = dustExit.value.tau[1] / dustExit.value.tau[4];
		const smokeRatio = smokeExit.value.tau[1] / smokeExit.value.tau[4];
		expect(smokeRatio).toBeGreaterThan(dustRatio);
		expect(smokeRatio / dustRatio).toBeGreaterThan(2);
	});

	it('returns tau values that are all finite and non-negative', async () => {
		for (const type of AEROSOL_TYPES) {
			const exit = await runCompute(type, 0.4);
			if (exit._tag !== 'Success') throw new Error(`compute failed for ${type}`);
			for (const t of exit.value.tau) {
				expect(Number.isFinite(t)).toBe(true);
				expect(t).toBeGreaterThanOrEqual(0);
			}
		}
	});
});
