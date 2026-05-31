import { Context, Data, Effect, Layer } from 'effect';
import { type AerosolType, aerosolEntry, refractiveIndexAt, sampleSizeDistribution } from '$lib/spectral/aerosol-types';
import { mie } from '$lib/spectral/mie';

/**
 * MieScatteringService — live aerosol optical depth via pure-TS Mie
 * scattering. Wraps the V2-A core + V2-B catalog behind an Effect tag so
 * `TransmissionEstimator.estimateWithLiveAerosol` (V2-C) can compose
 * cleanly with the LUT-backed gas absorption.
 *
 * The integration math:
 *   - For each requested wavelength λ, integrate Q_ext(x(r,λ), n+ik(λ))
 *     over the size distribution to get the per-particle extinction
 *     cross-section σ_ext(λ) [µm²].
 *   - The user-supplied AOD₅₅₀ calibrates the absolute scaling: we
 *     normalize σ_ext(λ) so that the value at 550 nm equals AOD₅₅₀.
 *   - Result: τ_aerosol(λ) ready to multiply by airmass downstream.
 *
 * The Ångström exponent slider does not enter the Mie path — pure Mie
 * gives the spectral shape automatically from the refractive index and
 * size distribution. Users who want to override the spectral shape stay
 * on the analytical (LUT) path.
 */

export interface MieAerosolInput {
	readonly aerosolType: AerosolType;
	readonly aod550: number;
}

export interface MieAerosolResult {
	readonly wavelengthsUm: ReadonlyArray<number>;
	/** Per-wavelength optical depth (at airmass = 1), calibrated to match AOD₅₅₀. */
	readonly tau: ReadonlyArray<number>;
	readonly aerosolType: AerosolType;
}

export class MieScatteringError extends Data.TaggedError('MieScatteringError')<{
	readonly reason: 'no-550nm-sample' | 'compute-failed';
	readonly cause?: unknown;
}> {}

export class MieScatteringService extends Context.Tag('@darkmap/MieScatteringService')<
	MieScatteringService,
	{
		readonly compute: (
			input: MieAerosolInput,
			wavelengthsUm: ReadonlyArray<number>,
		) => Effect.Effect<MieAerosolResult, MieScatteringError>;
	}
>() {}

/** Index of the wavelength closest to 0.55 µm in the supplied grid. */
const findIndexNear = (wavelengthsUm: ReadonlyArray<number>, target: number): number => {
	let bestIdx = 0;
	let bestDelta = Number.POSITIVE_INFINITY;
	for (let i = 0; i < wavelengthsUm.length; i++) {
		const d = Math.abs(wavelengthsUm[i] - target);
		if (d < bestDelta) {
			bestDelta = d;
			bestIdx = i;
		}
	}
	return bestIdx;
};

/** Build the live Mie service. Pure-functional — no IO inside the service. */
export const makeMieScatteringServiceLive = (sizeBins = 16): Layer.Layer<MieScatteringService> =>
	Layer.succeed(MieScatteringService, {
		compute: (input, wavelengthsUm) =>
			Effect.try({
				try: () => {
					const entry = aerosolEntry(input.aerosolType);
					const bins = sampleSizeDistribution(entry.sizeDistribution, sizeBins);

					// Per-wavelength extinction cross-section σ_ext(λ) [µm²].
					const sigmaExt = wavelengthsUm.map((lambda) => {
						const m = refractiveIndexAt(input.aerosolType, lambda);
						let s = 0;
						for (const bin of bins) {
							const x = (2 * Math.PI * bin.radiusUm) / lambda;
							const { qExt } = mie(x, m);
							s += bin.weight * Math.PI * bin.radiusUm * bin.radiusUm * qExt;
						}
						return s;
					});

					// Calibrate to AOD₅₅₀: scale all σ_ext(λ) so that the value at the
					// wavelength closest to 0.55 µm equals the user input.
					const idx550 = findIndexNear(wavelengthsUm, 0.55);
					const sigma550 = sigmaExt[idx550];
					if (!Number.isFinite(sigma550) || sigma550 <= 0) {
						throw new Error('Mie integration returned non-positive σ_ext at 550 nm');
					}
					const tau = sigmaExt.map((s) => (s / sigma550) * input.aod550);

					return {
						wavelengthsUm,
						tau,
						aerosolType: input.aerosolType,
					};
				},
				catch: (cause) => new MieScatteringError({ reason: 'compute-failed', cause }),
			}),
	});

/** Default Layer using 16 size-distribution bins. */
export const MieScatteringServiceLive: Layer.Layer<MieScatteringService> = makeMieScatteringServiceLive();
