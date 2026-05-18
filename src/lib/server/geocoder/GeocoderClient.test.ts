import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	GeocoderClient,
	GeocoderClientLive,
	GeocoderError,
	makeGeocoderClientStub,
	normalizePhotonFeature,
} from './GeocoderClient';

describe('normalizePhotonFeature', () => {
	const baseFeature = {
		type: 'Feature' as const,
		geometry: { type: 'Point' as const, coordinates: [-76.5019, 42.4434] as [number, number] },
		properties: {
			name: 'Ithaca',
			city: 'Ithaca',
			state: 'New York',
			country: 'United States',
			osm_id: 174697,
			osm_type: 'R',
		},
	};

	it('extracts name, lat/lon, and OSM ref', () => {
		const r = normalizePhotonFeature(baseFeature, 0, 1);
		expect(r.name).toBe('Ithaca');
		expect(r.lat).toBe(42.4434);
		expect(r.lon).toBe(-76.5019);
		expect(r.osm).toBe('osm:R/174697');
	});

	it('builds a comma-joined context from city/state/country', () => {
		const r = normalizePhotonFeature(baseFeature, 0, 1);
		expect(r.context).toBe('Ithaca, New York, United States');
	});

	it('omits missing fields from the context', () => {
		const r = normalizePhotonFeature(
			{
				...baseFeature,
				properties: { name: 'Antarctic Camp', country: 'Antarctica', osm_id: 1, osm_type: 'N' },
			},
			0,
			1,
		);
		expect(r.context).toBe('Antarctica');
	});

	it('drops the osm ref when osm_id or osm_type is missing', () => {
		const r = normalizePhotonFeature(
			{
				...baseFeature,
				properties: { name: 'Loose hit', country: 'US' },
			},
			0,
			1,
		);
		expect(r.osm).toBeUndefined();
	});

	it('emits a single-hit score of 1.0 when total is 1', () => {
		expect(normalizePhotonFeature(baseFeature, 0, 1).score).toBe(1);
	});

	it('decays score linearly across the rank list', () => {
		const top = normalizePhotonFeature(baseFeature, 0, 5).score;
		const bottom = normalizePhotonFeature(baseFeature, 4, 5).score;
		expect(top).toBe(1);
		expect(bottom).toBeGreaterThan(0);
		expect(bottom).toBeLessThan(top);
	});
});

describe('GeocoderClient (live, with mocked fetch)', () => {
	const withMockFetch = <T>(
		mockResponse: { ok: boolean; status?: number; json?: () => Promise<unknown> },
		fn: () => Promise<T>,
	): Promise<T> => {
		const orig = globalThis.fetch;
		globalThis.fetch = (() =>
			Promise.resolve({
				ok: mockResponse.ok,
				status: mockResponse.status ?? 200,
				json: mockResponse.json ?? (() => Promise.resolve({ type: 'FeatureCollection', features: [] })),
			} as unknown as Response)) as typeof globalThis.fetch;
		return fn().finally(() => {
			globalThis.fetch = orig;
		});
	};

	const run = () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const c = yield* GeocoderClient;
				return yield* c.search({ q: 'Ithaca', limit: 5 });
			}).pipe(Effect.provide(GeocoderClientLive)),
		);

	it('returns an empty array for an empty query without hitting the network', async () => {
		let called = false;
		const orig = globalThis.fetch;
		globalThis.fetch = (() => {
			called = true;
			return Promise.resolve({ ok: true } as Response);
		}) as typeof globalThis.fetch;
		try {
			const out = await Effect.runPromise(
				Effect.gen(function* () {
					const c = yield* GeocoderClient;
					return yield* c.search({ q: '   ' });
				}).pipe(Effect.provide(GeocoderClientLive)),
			);
			expect(out).toEqual([]);
			expect(called).toBe(false);
		} finally {
			globalThis.fetch = orig;
		}
	});

	it('normalizes a real-shape Photon response into GeocodeResult[]', async () => {
		const body = {
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					geometry: { type: 'Point', coordinates: [-76.5019, 42.4434] },
					properties: { name: 'Ithaca', country: 'United States', osm_id: 1, osm_type: 'R' },
				},
				{
					type: 'Feature',
					geometry: { type: 'Point', coordinates: [10.1, 50.1] },
					properties: { name: 'Ithaca DE', country: 'Germany', osm_id: 2, osm_type: 'N' },
				},
			],
		};
		const out = await withMockFetch({ ok: true, json: () => Promise.resolve(body) }, run);
		expect(out).toHaveLength(2);
		expect(out[0].name).toBe('Ithaca');
		expect(out[0].lat).toBe(42.4434);
		expect(out[1].osm).toBe('osm:N/2');
	});

	it('fails with GeocoderError on non-OK upstream status', async () => {
		const exit = await withMockFetch({ ok: false, status: 503 }, () =>
			Effect.runPromiseExit(
				Effect.gen(function* () {
					const c = yield* GeocoderClient;
					return yield* c.search({ q: 'foo' });
				}).pipe(Effect.provide(GeocoderClientLive)),
			),
		);
		expect(exit._tag).toBe('Failure');
	});
});

describe('makeGeocoderClientStub', () => {
	it('replaces the search impl entirely', async () => {
		const stub: Layer.Layer<GeocoderClient> = makeGeocoderClientStub((q) =>
			Effect.succeed([{ name: q.q, context: '', lat: 0, lon: 0, score: 1 }]),
		);
		const out = await Effect.runPromise(
			Effect.gen(function* () {
				const c = yield* GeocoderClient;
				return yield* c.search({ q: 'stubbed' });
			}).pipe(Effect.provide(stub)),
		);
		expect(out).toEqual([{ name: 'stubbed', context: '', lat: 0, lon: 0, score: 1 }]);
	});

	it('GeocoderError can be constructed with a reason', () => {
		const e = new GeocoderError({ reason: 'test' });
		expect(e.reason).toBe('test');
		expect(e._tag).toBe('GeocoderError');
	});
});
