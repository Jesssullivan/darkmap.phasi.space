import { Context, Data, Effect, Layer } from 'effect';
import {
	SPECTRAL_LUT_URL,
	SPECTRAL_LUT_VERSION,
	type SpectralLut,
	type TransmissionInput,
	type TransmissionLutAxes,
} from '$lib/spectral/transmission-axes';

/**
 * TransmissionEstimator — atmospheric transmission curve T(λ) for an input
 * (PWV, AOD550, Ångström, O₃, zenith). Lazy-loads the baked LUT from
 * `/spectral-lut.json` on first query (one-time per page lifetime),
 * quadrilinear-interpolates over the 5-D axis grid, and returns the full
 * wavelength spectrum the LUT was baked with.
 *
 * Engineering-grade estimate. V0 LUT comes from a closed-form analytical
 * model; V1 will swap in SMARTS + SBDART output without changing this
 * service's contract.
 */

export interface TransmissionCurve {
	readonly wavelengthsUm: ReadonlyArray<number>;
	/** T(λ) values matching `wavelengthsUm`, each in [0, 1]. */
	readonly transmission: ReadonlyArray<number>;
	/** Echo the input so the consumer can label the curve. */
	readonly input: TransmissionInput;
	/** LUT source name (e.g. `analytical-v0`). Surfaced as a disclaimer. */
	readonly source: string;
}

export class TransmissionEstimatorError extends Data.TaggedError('TransmissionEstimatorError')<{
	readonly reason: 'load-failed' | 'parse-failed' | 'version-mismatch';
	readonly cause?: unknown;
}> {}

export class TransmissionEstimator extends Context.Tag('@darkmap/TransmissionEstimator')<
	TransmissionEstimator,
	{
		readonly estimate: (input: TransmissionInput) => Effect.Effect<TransmissionCurve, TransmissionEstimatorError>;
	}
>() {}

export interface TransmissionEstimatorFetcher {
	readonly fetch: (
		url: string,
	) => Promise<{ readonly ok: boolean; readonly status: number; readonly json: () => Promise<unknown> }>;
}

const validateLut = (raw: unknown): SpectralLut => {
	if (typeof raw !== 'object' || raw === null) throw new Error('lut: not an object');
	const r = raw as Record<string, unknown>;
	if (typeof r.version !== 'number') throw new Error('lut: missing numeric version');
	if (r.version !== SPECTRAL_LUT_VERSION) {
		throw new Error(`lut: version mismatch (got ${r.version}, expected ${SPECTRAL_LUT_VERSION})`);
	}
	const axes = r.axes as Record<string, unknown>;
	if (!axes) throw new Error('lut: missing axes');
	for (const k of ['pwvMm', 'aod550', 'angstrom', 'o3Du', 'zenithDeg'] as const) {
		if (!Array.isArray(axes[k])) throw new Error(`lut: axis ${k} not an array`);
	}
	if (!Array.isArray(r.wavelengthsUm)) throw new Error('lut: missing wavelengthsUm');
	if (!Array.isArray(r.transmissionFlat)) throw new Error('lut: missing transmissionFlat');
	return r as unknown as SpectralLut;
};

/** Find the bracket [i, i+1] in a sorted ascending axis around `value`, plus the [0..1] fraction. */
const bracket = (axis: ReadonlyArray<number>, value: number): { lo: number; hi: number; t: number } => {
	const n = axis.length;
	if (n === 0) return { lo: 0, hi: 0, t: 0 };
	if (value <= axis[0]) return { lo: 0, hi: 0, t: 0 };
	if (value >= axis[n - 1]) return { lo: n - 1, hi: n - 1, t: 0 };
	let lo = 0;
	let hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (axis[mid] <= value) lo = mid;
		else hi = mid;
	}
	const span = axis[hi] - axis[lo];
	const t = span === 0 ? 0 : (value - axis[lo]) / span;
	return { lo, hi, t };
};

const indexOf = (
	axes: TransmissionLutAxes,
	wavelengthCount: number,
	pwvIdx: number,
	aodIdx: number,
	angIdx: number,
	o3Idx: number,
	zIdx: number,
	wlIdx: number,
): number => {
	const Z = axes.zenithDeg.length;
	const O = axes.o3Du.length;
	const A = axes.angstrom.length;
	const D = axes.aod550.length;
	return ((((pwvIdx * D + aodIdx) * A + angIdx) * O + o3Idx) * Z + zIdx) * wavelengthCount + wlIdx;
};

/**
 * Quadrilinear interpolation across all five axes for a single wavelength
 * index. Each axis contributes a (lo, hi, t) bracket; we sweep the 2⁵ = 32
 * corners and weight by the appropriate product of `t` / `1-t`.
 */
const interpAt = (
	lut: SpectralLut,
	wlIdx: number,
	brackets: ReadonlyArray<{ lo: number; hi: number; t: number }>,
): number => {
	let value = 0;
	for (let mask = 0; mask < 32; mask++) {
		let weight = 1;
		const idx: number[] = [];
		for (let bit = 0; bit < 5; bit++) {
			const b = brackets[bit];
			const useHi = ((mask >> bit) & 1) === 1;
			idx.push(useHi ? b.hi : b.lo);
			weight *= useHi ? b.t : 1 - b.t;
		}
		if (weight === 0) continue;
		const flatIdx = indexOf(lut.axes, lut.wavelengthsUm.length, idx[0], idx[1], idx[2], idx[3], idx[4], wlIdx);
		value += weight * lut.transmissionFlat[flatIdx];
	}
	return value;
};

export const makeTransmissionEstimatorLive = (
	fetcher: TransmissionEstimatorFetcher,
): Layer.Layer<TransmissionEstimator> => {
	let cached: SpectralLut | undefined;
	let inflight: Promise<SpectralLut> | undefined;
	const loadLut = async (): Promise<SpectralLut> => {
		if (cached) return cached;
		if (inflight) return inflight;
		inflight = (async () => {
			const res = await fetcher.fetch(SPECTRAL_LUT_URL);
			if (!res.ok) throw new Error(`lut fetch failed: ${res.status}`);
			const raw = await res.json();
			const lut = validateLut(raw);
			cached = lut;
			return lut;
		})().finally(() => {
			inflight = undefined;
		});
		return inflight;
	};

	return Layer.succeed(TransmissionEstimator, {
		estimate: (input) =>
			Effect.gen(function* () {
				const lut = yield* Effect.tryPromise({
					try: loadLut,
					catch: (cause) => {
						const message = cause instanceof Error ? cause.message : String(cause);
						const reason = message.includes('version mismatch') ? 'version-mismatch' : 'load-failed';
						return new TransmissionEstimatorError({ reason, cause });
					},
				});
				const brackets = [
					bracket(lut.axes.pwvMm, input.pwvMm),
					bracket(lut.axes.aod550, input.aod550),
					bracket(lut.axes.angstrom, input.angstrom),
					bracket(lut.axes.o3Du, input.o3Du),
					bracket(lut.axes.zenithDeg, input.zenithDeg),
				];
				const transmission = lut.wavelengthsUm.map((_, wlIdx) => interpAt(lut, wlIdx, brackets));
				return {
					wavelengthsUm: lut.wavelengthsUm,
					transmission,
					input,
					source: lut.source,
				};
			}),
	});
};

/**
 * Live Layer bound to the global `fetch`. SSR-safe: built lazily via
 * `Layer.suspend` so importing this module on the server doesn't immediately
 * eagerly read the global.
 */
export const TransmissionEstimatorLive: Layer.Layer<TransmissionEstimator> = Layer.suspend(() =>
	makeTransmissionEstimatorLive({ fetch: (url) => fetch(url) }),
);
