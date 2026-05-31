import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	makeOpenAQHistoryServiceLive,
	openAQHistoryUrl,
	OpenAQHistoryService,
	type OpenAQHistoryFetcher,
	type OpenAQHistoryRequest,
} from './OpenAQHistoryService';

/* ------------------------------ helpers ------------------------------ */

const sampleSeries = {
	parameter: 'pm25',
	units: 'µg/m³',
	points: [
		{ at: '2026-05-30T10:00:00Z', value: 10 },
		{ at: '2026-05-30T11:00:00Z', value: 14 },
	],
	sampleCount: 2,
	mean: 12,
	min: 10,
	max: 14,
	windowFrom: '2026-05-29T12:00:00Z',
	windowTo: '2026-05-30T12:00:00Z',
	latestAt: '2026-05-30T11:00:00Z',
	latestValue: 14,
	trend: 'rising',
	trendDelta: 4,
	stale: false,
};

const fakeOk = (body: unknown): OpenAQHistoryFetcher => ({
	fetch: async () => ({ ok: true, status: 200, json: async () => body }),
});
const fakeStatus = (status: number): OpenAQHistoryFetcher => ({
	fetch: async () => ({ ok: false, status, json: async () => ({}) }),
});
const fakeThrow = (cause: unknown): OpenAQHistoryFetcher => ({
	fetch: async () => {
		throw cause;
	},
});

const runWith = (fetcher: OpenAQHistoryFetcher, req: OpenAQHistoryRequest = { locationId: 42 }) =>
	Effect.runPromiseExit(
		Effect.gen(function* () {
			const svc = yield* OpenAQHistoryService;
			return yield* svc.getHistory(req);
		}).pipe(Effect.provide(makeOpenAQHistoryServiceLive(fetcher))),
	);

const failReason = (exit: Exit.Exit<unknown, unknown>): string => {
	const m = /"reason":"([^"]+)"/.exec(JSON.stringify(exit));
	if (!m) throw new Error(`no reason in cause: ${JSON.stringify(exit)}`);
	return m[1];
};

/* ----------------------------- URL helper ----------------------------- */

describe('openAQHistoryUrl', () => {
	it('uses locationId when present', () => {
		expect(openAQHistoryUrl({ locationId: 123, param: 'pm25', hours: 24 })).toBe(
			'/api/atmospheric/openaq-history?locationId=123&param=pm25&hours=24',
		);
	});
	it('falls back to lat/lon at 4 decimals', () => {
		expect(openAQHistoryUrl({ lat: 42.4434, lon: -76.5019, param: 'o3' })).toBe(
			'/api/atmospheric/openaq-history?lat=42.4434&lon=-76.5019&param=o3',
		);
	});
	it('prefers locationId over lat/lon', () => {
		const url = openAQHistoryUrl({ locationId: 7, lat: 1, lon: 2 });
		expect(url).toContain('locationId=7');
		expect(url).not.toContain('lat=');
	});
});

/* ------------------------------ service ------------------------------ */

describe('OpenAQHistoryService — getHistory', () => {
	it('parses a real series and preserves values', async () => {
		const exit = await runWith(fakeOk({ series: sampleSeries, locationId: 42, sensorId: 99, degraded: false }));
		if (exit._tag !== 'Success') throw new Error(`expected Success, got ${JSON.stringify(exit)}`);
		expect(exit.value.series?.sampleCount).toBe(2);
		expect(exit.value.series?.mean).toBe(12);
		expect(exit.value.series?.trend).toBe('rising');
		expect(exit.value.series?.points.map((p) => p.value)).toEqual([10, 14]);
		expect(exit.value.sensorId).toBe(99);
		expect(exit.value.degraded).toBe(false);
	});

	it('treats degraded {series:null} as a successful no-series result', async () => {
		const exit = await runWith(fakeOk({ series: null, degraded: true }));
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.series).toBeNull();
		expect(exit.value.degraded).toBe(true);
	});

	it('drops malformed points but keeps the valid ones', async () => {
		const exit = await runWith(
			fakeOk({
				series: {
					...sampleSeries,
					points: [
						{ at: '2026-05-30T10:00:00Z', value: 10 },
						{ at: 5, value: 1 }, // bad at
						{ at: '2026-05-30T11:00:00Z', value: 'nope' }, // bad value
						{ at: '2026-05-30T12:00:00Z', value: 14 },
					],
				},
			}),
		);
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.series?.points.map((p) => p.value)).toEqual([10, 14]);
	});

	it('rejects a series with an unknown parameter (→ null series)', async () => {
		const exit = await runWith(fakeOk({ series: { ...sampleSeries, parameter: 'bogus' }, degraded: false }));
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.series).toBeNull();
	});

	it('coerces a non-finite mean to null', async () => {
		const exit = await runWith(fakeOk({ series: { ...sampleSeries, mean: 'n/a' }, degraded: false }));
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.series?.mean).toBeNull();
	});

	it('reports fetch-failed on a non-2xx status', async () => {
		expect(failReason(await runWith(fakeStatus(502)))).toBe('fetch-failed');
	});
	it('reports fetch-failed when the fetcher throws', async () => {
		expect(failReason(await runWith(fakeThrow(new Error('down'))))).toBe('fetch-failed');
	});
	it('reports parse-failed when the body is not an object', async () => {
		expect(failReason(await runWith(fakeOk(null)))).toBe('parse-failed');
	});
});
