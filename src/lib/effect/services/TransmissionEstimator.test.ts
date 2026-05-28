import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { analyticalTransmission } from '$lib/spectral/analytical';
import {
	SPECTRAL_LUT_SOURCE,
	SPECTRAL_LUT_VERSION,
	type SpectralLut,
	type TransmissionLutAxes,
} from '$lib/spectral/transmission-axes';
import {
	makeTransmissionEstimatorLive,
	TransmissionEstimator,
	type TransmissionEstimatorFetcher,
} from './TransmissionEstimator';

/* ----------------------------- LUT fixture ----------------------------- */

const TINY_AXES: TransmissionLutAxes = {
	pwvMm: [0, 50],
	aod550: [0, 1.5],
	angstrom: [1.0, 2.0],
	o3Du: [300, 400],
	zenithDeg: [0, 60],
};

const TINY_WAVELENGTHS = [0.4, 0.55, 1.38, 2.0];

const bakeFixture = (): SpectralLut => {
	const flat: number[] = [];
	for (const pwvMm of TINY_AXES.pwvMm) {
		for (const aod550 of TINY_AXES.aod550) {
			for (const angstrom of TINY_AXES.angstrom) {
				for (const o3Du of TINY_AXES.o3Du) {
					for (const zenithDeg of TINY_AXES.zenithDeg) {
						for (const lambda of TINY_WAVELENGTHS) {
							flat.push(analyticalTransmission(lambda, { pwvMm, aod550, angstrom, o3Du, zenithDeg }));
						}
					}
				}
			}
		}
	}
	return {
		version: SPECTRAL_LUT_VERSION,
		source: SPECTRAL_LUT_SOURCE,
		generatedAt: '2026-05-28T00:00:00.000Z',
		axes: TINY_AXES,
		wavelengthsUm: TINY_WAVELENGTHS,
		transmissionFlat: flat,
	};
};

const makeFetcher = (body: unknown, ok = true, status = 200): TransmissionEstimatorFetcher => ({
	fetch: async () => ({ ok, status, json: async () => body }),
});

const failingFetcher = (): TransmissionEstimatorFetcher => ({
	fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
});

const failReason = (exit: Exit.Exit<unknown, unknown>): string => {
	const m = /"reason":"([^"]+)"/.exec(JSON.stringify(exit));
	if (!m) throw new Error(`no reason: ${JSON.stringify(exit)}`);
	return m[1];
};

const runWith = (fetcher: TransmissionEstimatorFetcher, input: Parameters<typeof analyticalTransmission>[1]) =>
	Effect.runPromiseExit(
		Effect.gen(function* () {
			const svc = yield* TransmissionEstimator;
			return yield* svc.estimate(input);
		}).pipe(Effect.provide(makeTransmissionEstimatorLive(fetcher))),
	);

/* ------------------------------ happy path ----------------------------- */

describe('TransmissionEstimator — interpolation', () => {
	it('returns a curve matching the LUT wavelength grid', async () => {
		const exit = await runWith(makeFetcher(bakeFixture()), {
			pwvMm: 0,
			aod550: 0,
			angstrom: 1.5,
			o3Du: 350,
			zenithDeg: 0,
		});
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.wavelengthsUm).toEqual(TINY_WAVELENGTHS);
		expect(exit.value.transmission).toHaveLength(TINY_WAVELENGTHS.length);
		expect(exit.value.source).toBe(SPECTRAL_LUT_SOURCE);
		exit.value.transmission.forEach((v) => {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		});
	});

	it('reproduces grid-point analytical values to ±0.01 (LUT is the analytical bake)', async () => {
		const input = { pwvMm: 0, aod550: 0, angstrom: 1.0, o3Du: 300, zenithDeg: 0 };
		const exit = await runWith(makeFetcher(bakeFixture()), input);
		if (exit._tag !== 'Success') throw new Error('expected Success');
		// Exact grid-corner — interp should hit the analytical value.
		const t550 = exit.value.transmission[1];
		const expected = analyticalTransmission(0.55, input);
		expect(t550).toBeCloseTo(expected, 2);
	});

	it('high PWV cuts 1.38 µm even at off-grid PWV (linear interp)', async () => {
		const wet = await runWith(makeFetcher(bakeFixture()), {
			pwvMm: 35,
			aod550: 0,
			angstrom: 1.5,
			o3Du: 350,
			zenithDeg: 0,
		});
		const dry = await runWith(makeFetcher(bakeFixture()), {
			pwvMm: 0,
			aod550: 0,
			angstrom: 1.5,
			o3Du: 350,
			zenithDeg: 0,
		});
		if (wet._tag !== 'Success' || dry._tag !== 'Success') throw new Error('expected Success');
		// Wavelength index 2 = 1.38 µm.
		expect(dry.value.transmission[2] - wet.value.transmission[2]).toBeGreaterThan(0.3);
	});

	it('clamps inputs outside the axis range without crashing', async () => {
		const exit = await runWith(makeFetcher(bakeFixture()), {
			pwvMm: 999, // way above max axis (50)
			aod550: -1, // below min axis (0)
			angstrom: 5,
			o3Du: 9999,
			zenithDeg: 100,
		});
		expect(exit._tag).toBe('Success');
	});

	it('caches the LUT — second estimate does not re-fetch', async () => {
		let fetches = 0;
		const fetcher: TransmissionEstimatorFetcher = {
			fetch: async () => {
				fetches++;
				return { ok: true, status: 200, json: async () => bakeFixture() };
			},
		};
		const layer = makeTransmissionEstimatorLive(fetcher);
		await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* TransmissionEstimator;
				yield* svc.estimate({ pwvMm: 0, aod550: 0, angstrom: 1.5, o3Du: 350, zenithDeg: 0 });
				yield* svc.estimate({ pwvMm: 30, aod550: 0.5, angstrom: 1.5, o3Du: 350, zenithDeg: 30 });
				return undefined;
			}).pipe(Effect.provide(layer)),
		);
		expect(fetches).toBe(1);
	});
});

/* ------------------------------ failures ------------------------------ */

describe('TransmissionEstimator — error reporting', () => {
	it('surfaces load-failed on a non-2xx fetch', async () => {
		const exit = await runWith(failingFetcher(), { pwvMm: 0, aod550: 0, angstrom: 1.5, o3Du: 350, zenithDeg: 0 });
		expect(failReason(exit)).toBe('load-failed');
	});

	it('surfaces version-mismatch when the LUT advertises a different version', async () => {
		const broken = { ...bakeFixture(), version: 999 };
		const exit = await runWith(makeFetcher(broken), {
			pwvMm: 0,
			aod550: 0,
			angstrom: 1.5,
			o3Du: 350,
			zenithDeg: 0,
		});
		expect(failReason(exit)).toBe('version-mismatch');
	});

	it('surfaces load-failed when the body is malformed', async () => {
		const exit = await runWith(makeFetcher({ nope: 1 }), {
			pwvMm: 0,
			aod550: 0,
			angstrom: 1.5,
			o3Du: 350,
			zenithDeg: 0,
		});
		expect(failReason(exit)).toBe('load-failed');
	});
});
