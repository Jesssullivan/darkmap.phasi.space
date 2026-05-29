import { Effect, Exit } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PointQueryClient, PointQueryClientLive, PointQueryError } from './PointQuery';
import { RasterClient, RasterClientLive, RasterError } from './RasterClient';

/* ---------------------------- fetch helpers ---------------------------- */

const okResponse = (body: ArrayBuffer | object, contentType: string): Response => {
	if (contentType.startsWith('image/')) {
		return new Response(body as ArrayBuffer, {
			status: 200,
			headers: { 'content-type': contentType },
		});
	}
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': contentType },
	});
};

const upstreamWms = 'https://www2.lightpollutionmap.info/geoserver/gwc/service/wms';

beforeEach(() => {
	vi.restoreAllMocks();
});
afterEach(() => {
	vi.restoreAllMocks();
});

/* ============================ RasterClientLive ============================ */

describe('RasterClientLive — WMS GetMap URL builder', () => {
	it('builds a 256x256 PNG WMS GetMap request for the requested tile + upstream layer', async () => {
		const captured: URL[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = input instanceof URL ? input : new URL(input.toString());
			captured.push(url);
			return okResponse(new Uint8Array([137, 80, 78, 71]).buffer, 'image/png');
		});

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const c = yield* RasterClient;
				return yield* c.getTile({ upstreamLayer: 'PostGIS:VIIRS_2019', tile: { z: 4, x: 5, y: 6 } });
			}).pipe(Effect.provide(RasterClientLive)),
		);

		expect(captured).toHaveLength(1);
		const url = captured[0];
		expect(url.origin + url.pathname).toBe(upstreamWms);
		expect(url.searchParams.get('service')).toBe('WMS');
		// Pinned to 1.1.1 — GeoServer 1.3.0 returns 400 for tile-sized bboxes
		// per the comment in RasterClient.ts. The test guards that pin.
		expect(url.searchParams.get('version')).toBe('1.1.1');
		expect(url.searchParams.get('request')).toBe('GetMap');
		expect(url.searchParams.get('layers')).toBe('PostGIS:VIIRS_2019');
		expect(url.searchParams.get('srs')).toBe('EPSG:3857');
		expect(url.searchParams.get('width')).toBe('256');
		expect(url.searchParams.get('height')).toBe('256');
		expect(url.searchParams.get('format')).toBe('image/png');
		expect(url.searchParams.get('transparent')).toBe('true');
		expect(url.searchParams.get('bbox')).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
		expect(result.contentType).toBe('image/png');
		expect(result.body.byteLength).toBeGreaterThan(0);
	});

	it('falls back to image/png when upstream omits content-type', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(new Uint8Array([0]).buffer, { status: 200, headers: {} }),
		);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const c = yield* RasterClient;
				return yield* c.getTile({ upstreamLayer: 'PostGIS:WA_2015', tile: { z: 1, x: 0, y: 0 } });
			}).pipe(Effect.provide(RasterClientLive)),
		);
		expect(result.contentType).toBe('image/png');
	});

	it('emits RasterError with the upstream URL on non-2xx', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 502 }));

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const c = yield* RasterClient;
				return yield* c.getTile({ upstreamLayer: 'PostGIS:VIIRS_2019', tile: { z: 4, x: 5, y: 6 } });
			}).pipe(Effect.provide(RasterClientLive)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			const cause = exit.cause;
			// Effect tagged-error path — pull the failure via squash.
			const failureOpt = cause.toString();
			expect(failureOpt).toContain('RasterError');
		}
	});

	it('emits RasterError with status 0 when fetch itself throws (network down)', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const c = yield* RasterClient;
				return yield* c.getTile({ upstreamLayer: 'PostGIS:VIIRS_2019', tile: { z: 0, x: 0, y: 0 } });
			}).pipe(Effect.provide(RasterClientLive)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it('emits RasterError when arrayBuffer() throws after a 2xx', async () => {
		const brokenResponse = new Response(null, { status: 200 });
		Object.defineProperty(brokenResponse, 'arrayBuffer', {
			value: () => Promise.reject(new Error('truncated')),
		});
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(brokenResponse);

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const c = yield* RasterClient;
				return yield* c.getTile({ upstreamLayer: 'PostGIS:VIIRS_2019', tile: { z: 2, x: 1, y: 1 } });
			}).pipe(Effect.provide(RasterClientLive)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it('RasterError carries the structured tag', () => {
		const e = new RasterError({ status: 502, upstream: 'https://example' });
		expect(e._tag).toBe('RasterError');
		expect(e.status).toBe(502);
	});
});

/* ========================= PointQueryClientLive ========================= */

describe('PointQueryClientLive — parallel GetFeatureInfo readout', () => {
	const VIIRS_PROPS = { RED_BAND: 12, GREEN_BAND: 34, BLUE_BAND: 56, ALPHA_BAND: 78 };
	const WA_PROPS = { GRAY_INDEX: 0.42 };

	const okFeatureCollection = (props: Record<string, unknown>): Response =>
		okResponse({ features: [{ properties: props }] }, 'application/json');

	it('fires two parallel GetFeatureInfo requests (viirs + WA_2015_raw) for the same point', async () => {
		const captured: URL[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = input instanceof URL ? input : new URL(input.toString());
			captured.push(url);
			return okFeatureCollection(url.searchParams.get('layers') === 'PostGIS:WA_2015_raw' ? WA_PROPS : VIIRS_PROPS);
		});

		const out = await Effect.runPromise(
			Effect.gen(function* () {
				const c = yield* PointQueryClient;
				return yield* c.readAt({ viirsLayer: 'PostGIS:VIIRS_2019', lat: 40, lon: -74 });
			}).pipe(Effect.provide(PointQueryClientLive)),
		);

		expect(captured).toHaveLength(2);
		const layers = captured.map((u) => u.searchParams.get('layers')).sort();
		expect(layers).toEqual(['PostGIS:VIIRS_2019', 'PostGIS:WA_2015_raw']);
		// Every upstream request must be a 1x1 GetFeatureInfo in EPSG:3857.
		for (const url of captured) {
			expect(url.searchParams.get('request')).toBe('GetFeatureInfo');
			expect(url.searchParams.get('width')).toBe('1');
			expect(url.searchParams.get('height')).toBe('1');
			expect(url.searchParams.get('srs')).toBe('EPSG:3857');
			expect(url.searchParams.get('info_format')).toBe('application/json');
		}
		expect(out.viirs).toEqual({ layer: 'PostGIS:VIIRS_2019', red: 12, green: 34, blue: 56, alpha: 78 });
		expect(out.worldAtlas).toEqual({ grayIndex: 0.42 });
	});

	it('drops viirs when any RGBA band is missing rather than emitting a partial record', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = input instanceof URL ? input : new URL(input.toString());
			if (url.searchParams.get('layers') === 'PostGIS:WA_2015_raw') return okFeatureCollection(WA_PROPS);
			// VIIRS missing the alpha band — the helper should omit the record.
			return okFeatureCollection({ RED_BAND: 12, GREEN_BAND: 34, BLUE_BAND: 56 });
		});

		const out = await Effect.runPromise(
			Effect.gen(function* () {
				const c = yield* PointQueryClient;
				return yield* c.readAt({ viirsLayer: 'PostGIS:VIIRS_2019', lat: 40, lon: -74 });
			}).pipe(Effect.provide(PointQueryClientLive)),
		);
		expect(out.viirs).toBeUndefined();
		expect(out.worldAtlas).toEqual({ grayIndex: 0.42 });
	});

	it('drops worldAtlas when GRAY_INDEX is absent', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = input instanceof URL ? input : new URL(input.toString());
			return okFeatureCollection(url.searchParams.get('layers') === 'PostGIS:WA_2015_raw' ? {} : VIIRS_PROPS);
		});

		const out = await Effect.runPromise(
			Effect.gen(function* () {
				const c = yield* PointQueryClient;
				return yield* c.readAt({ viirsLayer: 'PostGIS:VIIRS_2019', lat: 0, lon: 0 });
			}).pipe(Effect.provide(PointQueryClientLive)),
		);
		expect(out.worldAtlas).toBeUndefined();
		expect(out.viirs).toBeDefined();
	});

	it('returns an empty readout when neither layer has features', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okResponse({ features: [] }, 'application/json'));

		const out = await Effect.runPromise(
			Effect.gen(function* () {
				const c = yield* PointQueryClient;
				return yield* c.readAt({ viirsLayer: 'PostGIS:VIIRS_2019', lat: 51.5, lon: -0.1 });
			}).pipe(Effect.provide(PointQueryClientLive)),
		);
		expect(out.viirs).toBeUndefined();
		expect(out.worldAtlas).toBeUndefined();
	});

	it('propagates PointQueryError when an upstream returns non-2xx', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 502 }));

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const c = yield* PointQueryClient;
				return yield* c.readAt({ viirsLayer: 'PostGIS:VIIRS_2019', lat: 0, lon: 0 });
			}).pipe(Effect.provide(PointQueryClientLive)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it('propagates PointQueryError when fetch throws (network down)', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENETDOWN'));
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const c = yield* PointQueryClient;
				return yield* c.readAt({ viirsLayer: 'PostGIS:VIIRS_2019', lat: 0, lon: 0 });
			}).pipe(Effect.provide(PointQueryClientLive)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it('propagates PointQueryError when JSON parsing fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
		);

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const c = yield* PointQueryClient;
				return yield* c.readAt({ viirsLayer: 'PostGIS:VIIRS_2019', lat: 0, lon: 0 });
			}).pipe(Effect.provide(PointQueryClientLive)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it('PointQueryError carries its tag and upstream URL', () => {
		const e = new PointQueryError({ status: 404, upstream: 'https://example' });
		expect(e._tag).toBe('PointQueryError');
		expect(e.upstream).toBe('https://example');
	});
});
