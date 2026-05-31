import { Context, Data, Effect, Layer } from 'effect';
import { findHitranBand, type HitranMolecule } from '$lib/spectral/hitran-bands';

/**
 * LineByLineService — lazy-loads per-band line-by-line transmission curves
 * from `/spectral-lbl/{bandId}.json` and serves them as fine-grained
 * `BandCurve` results. The V3b-2 bake produced one JSON per named band at
 * 0.01 nm resolution; the V3b-4 widget detail panel consumes them when the
 * user clicks a band tick on the main transmission chart.
 *
 * The shape mirrors `TransmissionEstimator` so the widget can treat both
 * services interchangeably — a coarse LUT curve from the estimator (~60
 * wavelengths over 0.3-30 µm) vs a dense LBL curve from this service
 * (~5000-30000 wavelengths over a single band).
 */

export interface BandLineByLine {
	readonly bandId: string;
	readonly molecule: HitranMolecule;
	readonly version: number;
	readonly source: string;
	readonly generatedAt: string;
	readonly wavelengthsUm: ReadonlyArray<number>;
	/** Baked optical depth τ(λ) at the reference column, airmass = 1. */
	readonly tau: ReadonlyArray<number>;
	readonly refColumn: number;
	readonly attribution: string;
}

export interface BandCurve {
	readonly bandId: string;
	readonly molecule: HitranMolecule;
	readonly wavelengthsUm: ReadonlyArray<number>;
	readonly transmission: ReadonlyArray<number>;
	readonly source: string;
	readonly attribution: string;
}

export interface EstimateInBandInput {
	readonly bandId: string;
	/** Airmass multiplier applied to the baked τ. Defaults to 1 (zenith). */
	readonly airmass?: number;
	/** Multiplicative scale of the molecule column relative to the baked ref. Defaults to 1. */
	readonly columnScale?: number;
}

export class LineByLineError extends Data.TaggedError('LineByLineError')<{
	readonly reason: 'unknown-band' | 'load-failed' | 'parse-failed';
	readonly bandId?: string;
	readonly cause?: unknown;
}> {}

export class LineByLineService extends Context.Tag('@darkmap/LineByLineService')<
	LineByLineService,
	{
		readonly estimateInBand: (input: EstimateInBandInput) => Effect.Effect<BandCurve, LineByLineError>;
	}
>() {}

export interface LineByLineFetcher {
	readonly fetch: (
		url: string,
	) => Promise<{ readonly ok: boolean; readonly status: number; readonly json: () => Promise<unknown> }>;
}

const validateBand = (raw: unknown): BandLineByLine => {
	if (typeof raw !== 'object' || raw === null) throw new Error('lbl: not an object');
	const r = raw as Record<string, unknown>;
	if (typeof r.bandId !== 'string') throw new Error('lbl: missing bandId');
	if (!Array.isArray(r.wavelengthsUm)) throw new Error('lbl: wavelengthsUm not an array');
	if (!Array.isArray(r.tau)) throw new Error('lbl: tau not an array');
	if (r.wavelengthsUm.length !== r.tau.length) {
		throw new Error('lbl: wavelengthsUm.length ≠ tau.length');
	}
	if (typeof r.refColumn !== 'number') throw new Error('lbl: refColumn missing');
	return r as unknown as BandLineByLine;
};

export const makeLineByLineServiceLive = (fetcher: LineByLineFetcher): Layer.Layer<LineByLineService> => {
	const cache = new Map<string, BandLineByLine>();
	const inflight = new Map<string, Promise<BandLineByLine>>();

	const loadBand = (bandId: string): Promise<BandLineByLine> => {
		const cached = cache.get(bandId);
		if (cached) return Promise.resolve(cached);
		const pending = inflight.get(bandId);
		if (pending) return pending;
		const promise = (async () => {
			const res = await fetcher.fetch(`/spectral-lbl/${bandId}.json`);
			if (!res.ok) throw new Error(`lbl fetch failed: ${res.status}`);
			const body = await res.json();
			const baked = validateBand(body);
			cache.set(bandId, baked);
			return baked;
		})().finally(() => inflight.delete(bandId));
		inflight.set(bandId, promise);
		return promise;
	};

	return Layer.succeed(LineByLineService, {
		estimateInBand: (input) =>
			Effect.gen(function* () {
				const band = findHitranBand(input.bandId);
				if (!band) {
					return yield* Effect.fail(new LineByLineError({ reason: 'unknown-band', bandId: input.bandId }));
				}
				const baked = yield* Effect.tryPromise({
					try: () => loadBand(input.bandId),
					catch: (cause) =>
						new LineByLineError({
							reason: cause instanceof Error && cause.message.includes('lbl:') ? 'parse-failed' : 'load-failed',
							bandId: input.bandId,
							cause,
						}),
				});

				const airmass = input.airmass ?? 1;
				const columnScale = input.columnScale ?? 1;
				const scale = airmass * columnScale;
				const transmission = baked.tau.map((t) => {
					const T = Math.exp(-t * scale);
					return T < 0 ? 0 : T > 1 ? 1 : T;
				});
				return {
					bandId: baked.bandId,
					molecule: baked.molecule,
					wavelengthsUm: baked.wavelengthsUm,
					transmission,
					source: baked.source,
					attribution: baked.attribution,
				};
			}),
	});
};

export const LineByLineServiceLive: Layer.Layer<LineByLineService> = Layer.suspend(() =>
	makeLineByLineServiceLive({ fetch: (url) => fetch(url) }),
);
