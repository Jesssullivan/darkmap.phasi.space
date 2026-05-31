import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { openAQUrl, OpenAQService, makeOpenAQServiceLive, type OpenAQFetcher } from './OpenAQService';

const BBOX = { west: -74.5, south: 40.5, east: -73.5, north: 41.0 };

const makeBody = (
	features: ReadonlyArray<{ value: number | null; locationName: string; lon: number; lat: number }>,
	degraded = false,
) => ({
	type: 'FeatureCollection',
	degraded,
	features: features.map((f) => ({
		type: 'Feature',
		properties: { value: f.value, locationName: f.locationName },
		geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
	})),
});

const fakeOk = (body: unknown): OpenAQFetcher => ({
	fetch: async () => ({ ok: true, status: 200, json: async () => body }),
});

const fakeStatus = (status: number): OpenAQFetcher => ({
	fetch: async () => ({ ok: false, status, json: async () => ({}) }),
});

const fakeThrow = (cause: unknown): OpenAQFetcher => ({
	fetch: async () => {
		throw cause;
	},
});

const runWith = (fetcher: OpenAQFetcher) =>
	Effect.runPromiseExit(
		Effect.gen(function* () {
			const svc = yield* OpenAQService;
			return yield* svc.getSensors(BBOX);
		}).pipe(Effect.provide(makeOpenAQServiceLive(fetcher))),
	);

const failReason = (exit: Exit.Exit<unknown, unknown>): string => {
	const m = /"reason":"([^"]+)"/.exec(JSON.stringify(exit));
	if (!m) throw new Error(`no reason: ${JSON.stringify(exit)}`);
	return m[1];
};

describe('openAQUrl', () => {
	it('serializes a bbox to the proxy URL with 4-decimal precision', () => {
		expect(openAQUrl({ west: -76.5019, south: 42.4434, east: -76.4, north: 42.5 })).toBe(
			'/api/atmospheric/openaq?bbox=-76.5019,42.4434,-76.4000,42.5000',
		);
	});
});

describe('OpenAQService — getSensors', () => {
	it('returns parsed features when upstream is ok', async () => {
		const exit = await runWith(
			fakeOk(
				makeBody([
					{ value: 18.2, locationName: 'Bronx', lon: -73.85, lat: 40.85 },
					{ value: null, locationName: 'Sensor-down', lon: -74.0, lat: 40.7 },
				]),
			),
		);
		if (exit._tag !== 'Success') throw new Error(`expected Success: ${JSON.stringify(exit)}`);
		const fc = exit.value;
		expect(fc.type).toBe('FeatureCollection');
		expect(fc.features).toHaveLength(2);
		expect(fc.features[0].properties.value).toBe(18.2);
		expect(fc.features[0].properties.locationName).toBe('Bronx');
		expect(fc.features[1].properties.value).toBeNull();
		expect(fc.degraded).toBe(false);
	});

	it('passes through the degraded flag', async () => {
		const exit = await runWith(fakeOk(makeBody([], true)));
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.degraded).toBe(true);
		expect(exit.value.features).toHaveLength(0);
	});

	it('passes abort signals through to the fetcher', async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | undefined;
		const fetcher: OpenAQFetcher = {
			fetch: async (_url, init) => {
				seenSignal = init?.signal;
				return { ok: true, status: 200, json: async () => makeBody([]) };
			},
		};
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* OpenAQService;
				return yield* svc.getSensors(BBOX, { signal: controller.signal });
			}).pipe(Effect.provide(makeOpenAQServiceLive(fetcher))),
		);
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(seenSignal).toBe(controller.signal);
	});

	it('drops malformed features without failing the request', async () => {
		const exit = await runWith(
			fakeOk({
				type: 'FeatureCollection',
				features: [
					{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: ['x', 'y'] } },
					{
						type: 'Feature',
						properties: { value: 10, locationName: 'OK' },
						geometry: { type: 'Point', coordinates: [-73, 40] },
					},
					{ type: 'NotAFeature' },
				],
			}),
		);
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.features).toHaveLength(1);
		expect(exit.value.features[0].properties.locationName).toBe('OK');
	});

	it('reports fetch-failed on non-2xx', async () => {
		const exit = await runWith(fakeStatus(503));
		expect(failReason(exit)).toBe('fetch-failed');
	});

	it('reports fetch-failed when the fetcher throws', async () => {
		const exit = await runWith(fakeThrow(new Error('down')));
		expect(failReason(exit)).toBe('fetch-failed');
	});

	it('reports parse-failed when the body is not a FeatureCollection', async () => {
		const exit = await runWith(fakeOk({ type: 'NotACollection' }));
		expect(failReason(exit)).toBe('parse-failed');
	});

	it('reports parse-failed when the body is null', async () => {
		const exit = await runWith(fakeOk(null));
		expect(failReason(exit)).toBe('parse-failed');
	});
});

describe('OpenAQService — multi-pollutant parsing (AQ-1)', () => {
	it('passes through per-pollutant readings keyed by parameter name', async () => {
		const body = {
			type: 'FeatureCollection',
			degraded: false,
			features: [
				{
					type: 'Feature',
					properties: {
						locationName: 'Test',
						value: 12,
						pollutants: { pm25: { value: 12, units: 'µg/m³' }, no2: { value: 20 }, bogus: { value: 9 } },
					},
					geometry: { type: 'Point', coordinates: [-74, 40.7] },
				},
			],
		};
		const exit = await runWith(fakeOk(body));
		if (exit._tag !== 'Success') throw new Error('expected Success');
		const p = exit.value.features[0].properties.pollutants;
		expect(p.pm25).toEqual({ value: 12, units: 'µg/m³' });
		expect(p.no2).toEqual({ value: 20 });
		// Unknown parameter names are dropped.
		expect((p as Record<string, unknown>).bogus).toBeUndefined();
	});

	it('defaults to an empty pollutants map when absent', async () => {
		const exit = await runWith(fakeOk(makeBody([{ value: 5, locationName: 'X', lon: -74, lat: 40.7 }])));
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.features[0].properties.pollutants).toEqual({});
	});
});
