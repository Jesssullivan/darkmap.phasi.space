import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	airQualityPointUrl,
	AirQualityService,
	type AirQualityFetcher,
	makeAirQualityServiceLive,
} from './AirQualityService';

/* ------------------------------ helpers ------------------------------ */

const sample = {
	matchedTime: '2026-05-30T12:00',
	pollen: { alder: 0, birch: 12.5, grass: null, mugwort: null, olive: null, ragweed: 3 },
	pm25: 8.2,
	pm10: 14,
	aod550: 0.11,
	dust: 1.4,
	ozone: 62,
};

const fakeOk = (body: unknown): AirQualityFetcher => ({
	fetch: async () => ({ ok: true, status: 200, json: async () => body }),
});
const fakeStatus = (status: number): AirQualityFetcher => ({
	fetch: async () => ({ ok: false, status, json: async () => ({}) }),
});
const fakeThrow = (cause: unknown): AirQualityFetcher => ({
	fetch: async () => {
		throw cause;
	},
});

const runWith = (fetcher: AirQualityFetcher) =>
	Effect.runPromiseExit(
		Effect.gen(function* () {
			const svc = yield* AirQualityService;
			return yield* svc.getReading({ lat: 42.44, lon: -76.5, time: new Date('2026-05-30T12:14:00Z') });
		}).pipe(Effect.provide(makeAirQualityServiceLive(fetcher))),
	);

const failReason = (exit: Exit.Exit<unknown, unknown>): string => {
	const m = /"reason":"([^"]+)"/.exec(JSON.stringify(exit));
	if (!m) throw new Error(`no reason in cause: ${JSON.stringify(exit)}`);
	return m[1];
};

/* ----------------------------- URL helper ----------------------------- */

describe('airQualityPointUrl', () => {
	it('encodes lat/lon to 4 decimals and ISO-encodes the time', () => {
		const url = airQualityPointUrl({ lat: 42.4434, lon: -76.5019, time: new Date('2026-05-30T12:14:00Z') });
		expect(url).toBe('/api/atmospheric/airquality?lat=42.4434&lon=-76.5019&time=2026-05-30T12%3A14%3A00.000Z');
	});
});

/* ------------------------------ service ------------------------------ */

describe('AirQualityService — getReading', () => {
	it('shapes a reading and preserves real values', async () => {
		const exit = await runWith(fakeOk(sample));
		if (exit._tag !== 'Success') throw new Error(`expected Success, got ${JSON.stringify(exit)}`);
		expect(exit.value.pollen.birch).toBe(12.5);
		expect(exit.value.pollen.ragweed).toBe(3);
		expect(exit.value.pm25).toBe(8.2);
		expect(exit.value.aod550).toBe(0.11);
		expect(exit.value.matchedTime).toBe('2026-05-30T12:00');
	});

	it('keeps a real zero distinct from a missing value', async () => {
		const exit = await runWith(fakeOk(sample));
		if (exit._tag !== 'Success') throw new Error('expected Success');
		// alder is a measured 0 (in season, none today) — must NOT be coerced to null.
		expect(exit.value.pollen.alder).toBe(0);
	});

	it('maps out-of-season / unsupported species to null (never zero)', async () => {
		const exit = await runWith(fakeOk(sample));
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.pollen.grass).toBeNull();
		expect(exit.value.pollen.olive).toBeNull();
	});

	it('coerces non-finite constituents to null', async () => {
		const exit = await runWith(fakeOk({ ...sample, pm25: 'n/a', ozone: null }));
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.pm25).toBeNull();
		expect(exit.value.ozone).toBeNull();
	});

	it('tolerates a missing pollen object', async () => {
		const { pollen: _omit, ...rest } = sample;
		void _omit;
		const exit = await runWith(fakeOk(rest));
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.pollen.birch).toBeNull();
	});

	it('reports fetch-failed on a non-2xx status', async () => {
		expect(failReason(await runWith(fakeStatus(502)))).toBe('fetch-failed');
	});
	it('reports fetch-failed when the fetcher throws', async () => {
		expect(failReason(await runWith(fakeThrow(new Error('down'))))).toBe('fetch-failed');
	});
	it('reports parse-failed when matchedTime is missing', async () => {
		const { matchedTime: _omit, ...rest } = sample;
		void _omit;
		expect(failReason(await runWith(fakeOk(rest)))).toBe('parse-failed');
	});
	it('reports no-data when the body is null', async () => {
		expect(failReason(await runWith(fakeOk(null)))).toBe('no-data');
	});
});
