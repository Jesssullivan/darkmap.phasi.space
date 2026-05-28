import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	LineByLineService,
	makeLineByLineServiceLive,
	type BandLineByLine,
	type LineByLineFetcher,
} from './LineByLineService';

const sampleBand: BandLineByLine = {
	bandId: 'h2o-940nm',
	molecule: 'h2o',
	version: 1,
	source: 'voigt-lbl-v1',
	generatedAt: '2026-05-28T00:00:00.000Z',
	wavelengthsUm: [0.93, 0.94, 0.95],
	tau: [0.2, 1.5, 0.3],
	refColumn: 5e22,
	attribution: 'HITRAN2020',
};

const fakeOk = (body: unknown, ok = true, status = 200): LineByLineFetcher => ({
	fetch: async () => ({ ok, status, json: async () => body }),
});

const failReason = (exit: Exit.Exit<unknown, unknown>): string => {
	const m = /"reason":"([^"]+)"/.exec(JSON.stringify(exit));
	if (!m) throw new Error(`no reason: ${JSON.stringify(exit)}`);
	return m[1];
};

const runWith = (fetcher: LineByLineFetcher, input: Parameters<typeof Effect.gen>) => void input;

describe('LineByLineService — happy path', () => {
	it('returns the matching band curve with transmission = exp(-τ)', async () => {
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* LineByLineService;
				return yield* svc.estimateInBand({ bandId: 'h2o-940nm' });
			}).pipe(Effect.provide(makeLineByLineServiceLive(fakeOk(sampleBand)))),
		);
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.bandId).toBe('h2o-940nm');
		expect(exit.value.wavelengthsUm).toEqual(sampleBand.wavelengthsUm);
		expect(exit.value.transmission).toHaveLength(3);
		expect(exit.value.transmission[0]).toBeCloseTo(Math.exp(-0.2), 6);
		expect(exit.value.transmission[1]).toBeCloseTo(Math.exp(-1.5), 6);
		expect(exit.value.attribution).toMatch(/HITRAN/);
	});

	it('airmass scales τ multiplicatively', async () => {
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* LineByLineService;
				return yield* svc.estimateInBand({ bandId: 'h2o-940nm', airmass: 2 });
			}).pipe(Effect.provide(makeLineByLineServiceLive(fakeOk(sampleBand)))),
		);
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.transmission[1]).toBeCloseTo(Math.exp(-1.5 * 2), 6);
	});

	it('columnScale scales τ multiplicatively (independent of airmass)', async () => {
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* LineByLineService;
				return yield* svc.estimateInBand({ bandId: 'h2o-940nm', columnScale: 0.5 });
			}).pipe(Effect.provide(makeLineByLineServiceLive(fakeOk(sampleBand)))),
		);
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.transmission[1]).toBeCloseTo(Math.exp(-1.5 * 0.5), 6);
	});

	it('caches the band — second estimateInBand does not re-fetch', async () => {
		let fetches = 0;
		const fetcher: LineByLineFetcher = {
			fetch: async () => {
				fetches++;
				return { ok: true, status: 200, json: async () => sampleBand };
			},
		};
		const layer = makeLineByLineServiceLive(fetcher);
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* LineByLineService;
				yield* svc.estimateInBand({ bandId: 'h2o-940nm' });
				yield* svc.estimateInBand({ bandId: 'h2o-940nm', airmass: 2 });
				return undefined;
			}).pipe(Effect.provide(layer)),
		);
		expect(exit._tag).toBe('Success');
		expect(fetches).toBe(1);
	});
});

describe('LineByLineService — failures', () => {
	it('surfaces unknown-band for an id not in the manifest', async () => {
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* LineByLineService;
				return yield* svc.estimateInBand({ bandId: 'not-a-band' });
			}).pipe(Effect.provide(makeLineByLineServiceLive(fakeOk(sampleBand)))),
		);
		expect(failReason(exit)).toBe('unknown-band');
	});

	it('surfaces load-failed on non-2xx fetch', async () => {
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* LineByLineService;
				return yield* svc.estimateInBand({ bandId: 'h2o-940nm' });
			}).pipe(Effect.provide(makeLineByLineServiceLive(fakeOk({}, false, 404)))),
		);
		expect(failReason(exit)).toBe('load-failed');
	});

	it('surfaces parse-failed on a malformed body', async () => {
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* LineByLineService;
				return yield* svc.estimateInBand({ bandId: 'h2o-940nm' });
			}).pipe(Effect.provide(makeLineByLineServiceLive(fakeOk({ bandId: 'h2o-940nm', tau: [1, 2] })))),
		);
		expect(failReason(exit)).toBe('parse-failed');
	});
});

void runWith; // satisfies tsc when imports are tree-shaken
