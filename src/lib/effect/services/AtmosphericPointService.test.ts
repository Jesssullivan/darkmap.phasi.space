import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	atmosphericPointUrl,
	AtmosphericPointService,
	makeAtmosphericPointServiceLive,
	type AtmosphericPointFetcher,
} from './AtmosphericPointService';

/* ------------------------------ helpers ------------------------------ */

const sampleReading = {
	pwv: 24.3,
	rh: 78,
	cloudLow: 12,
	cloudMid: 4,
	cloudHigh: 41,
	visibility: 18_500,
	matchedTime: '2026-05-27T22:00',
};

const fakeOk = (body: unknown): AtmosphericPointFetcher => ({
	fetch: async () => ({ ok: true, status: 200, json: async () => body }),
});

const fakeStatus = (status: number): AtmosphericPointFetcher => ({
	fetch: async () => ({ ok: false, status, json: async () => ({}) }),
});

const fakeThrow = (cause: unknown): AtmosphericPointFetcher => ({
	fetch: async () => {
		throw cause;
	},
});

const runWith = (fetcher: AtmosphericPointFetcher) =>
	Effect.runPromiseExit(
		Effect.gen(function* () {
			const svc = yield* AtmosphericPointService;
			return yield* svc.getReading({ lat: 42.44, lon: -76.5, time: new Date('2026-05-27T22:14:00Z') });
		}).pipe(Effect.provide(makeAtmosphericPointServiceLive(fetcher))),
	);

const failReason = (exit: Exit.Exit<unknown, unknown>): string => {
	const m = /"reason":"([^"]+)"/.exec(JSON.stringify(exit));
	if (!m) throw new Error(`no reason in cause: ${JSON.stringify(exit)}`);
	return m[1];
};

/* ----------------------------- URL helper ----------------------------- */

describe('atmosphericPointUrl', () => {
	it('encodes lat/lon to 4 decimals and ISO-encodes the time', () => {
		const url = atmosphericPointUrl({
			lat: 42.4434,
			lon: -76.5019,
			time: new Date('2026-05-27T22:14:00Z'),
		});
		expect(url).toBe('/api/atmospheric/point?lat=42.4434&lon=-76.5019&time=2026-05-27T22%3A14%3A00.000Z');
	});
});

/* ------------------------------ service ------------------------------ */

describe('AtmosphericPointService — getReading', () => {
	it('returns a shaped reading when upstream is ok', async () => {
		const exit = await runWith(fakeOk(sampleReading));
		if (exit._tag !== 'Success') throw new Error(`expected Success, got ${JSON.stringify(exit)}`);
		expect(exit.value.pwv).toBe(24.3);
		expect(exit.value.rh).toBe(78);
		expect(exit.value.cloudLow).toBe(12);
		expect(exit.value.cloudMid).toBe(4);
		expect(exit.value.cloudHigh).toBe(41);
		expect(exit.value.visibility).toBe(18_500);
		expect(exit.value.matchedTime).toBe('2026-05-27T22:00');
	});

	it('allows PWV to be unavailable while preserving the rest of the reading', async () => {
		const exit = await runWith(fakeOk({ ...sampleReading, pwv: null }));
		if (exit._tag !== 'Success') throw new Error(`expected Success, got ${JSON.stringify(exit)}`);
		expect(exit.value.pwv).toBeNull();
		expect(exit.value.rh).toBe(78);
	});

	it('passes abort signals through to the fetcher', async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | undefined;
		const fetcher: AtmosphericPointFetcher = {
			fetch: async (_url, init) => {
				seenSignal = init?.signal;
				return { ok: true, status: 200, json: async () => sampleReading };
			},
		};
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* AtmosphericPointService;
				return yield* svc.getReading(
					{ lat: 42.44, lon: -76.5, time: new Date('2026-05-27T22:14:00Z') },
					{ signal: controller.signal },
				);
			}).pipe(Effect.provide(makeAtmosphericPointServiceLive(fetcher))),
		);
		if (exit._tag !== 'Success') throw new Error(`expected Success, got ${JSON.stringify(exit)}`);
		expect(seenSignal).toBe(controller.signal);
	});

	it('reports fetch-failed on a non-2xx status', async () => {
		const exit = await runWith(fakeStatus(503));
		expect(failReason(exit)).toBe('fetch-failed');
	});

	it('reports fetch-failed when the fetcher throws', async () => {
		const exit = await runWith(fakeThrow(new Error('network down')));
		expect(failReason(exit)).toBe('fetch-failed');
	});

	it('reports parse-failed when a required numeric field is missing', async () => {
		const exit = await runWith(fakeOk({ ...sampleReading, rh: 'not-a-number' }));
		expect(failReason(exit)).toBe('parse-failed');
	});

	it('reports parse-failed when PWV is neither numeric nor null', async () => {
		const exit = await runWith(fakeOk({ ...sampleReading, pwv: 'not-a-number' }));
		expect(failReason(exit)).toBe('parse-failed');
	});

	it('reports parse-failed when matchedTime is missing', async () => {
		const { matchedTime: _omit, ...rest } = sampleReading;
		void _omit;
		const exit = await runWith(fakeOk(rest));
		expect(failReason(exit)).toBe('parse-failed');
	});

	it('reports no-data when the body is null', async () => {
		const exit = await runWith(fakeOk(null));
		expect(failReason(exit)).toBe('no-data');
	});
});
