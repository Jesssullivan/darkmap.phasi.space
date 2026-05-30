import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { LAYERS, type RasterLayerDef } from '$lib/layers';
import {
	AtmosphericTileService,
	makeAtmosphericTileServiceLive,
	type AtmosphericTileFetcher,
} from './AtmosphericTileService';

const modisTerra = LAYERS.find((l) => l.id === 'clouds-modis-terra')! as RasterLayerDef;
const tile = { z: 5, x: 7, y: 12 };

const okJpeg = (bytes = 5_000, contentType = 'image/jpeg', status = 200): Response =>
	new Response(new Uint8Array(bytes), {
		status,
		headers: { 'content-type': contentType, 'content-length': String(bytes) },
	});

const status204 = (): Response => new Response(null, { status: 204 });
const status404 = (): Response => new Response('not found', { status: 404 });
const status503 = (): Response => new Response('upstream down', { status: 503 });
const emptyPng = (): Response =>
	new Response(new Uint8Array(50), {
		status: 200,
		headers: { 'content-type': 'image/png', 'content-length': '50' },
	});

const fakeFetcher = (response: Response | (() => Response), capture?: { url?: string }): AtmosphericTileFetcher => ({
	fetch: async (url) => {
		if (capture) capture.url = url;
		return typeof response === 'function' ? response() : response.clone();
	},
});

const sequenceFetcher = (responses: readonly Response[], capture: { urls: string[] }): AtmosphericTileFetcher => {
	let i = 0;
	return {
		fetch: async (url) => {
			capture.urls.push(url);
			const response = responses[i];
			i += 1;
			if (!response) throw new Error(`unexpected fetch: ${url}`);
			return response;
		},
	};
};

const failReason = (exit: Exit.Exit<unknown, unknown>): string => {
	const m = /"reason":"([^"]+)"/.exec(JSON.stringify(exit));
	if (!m) throw new Error(`no reason in cause: ${JSON.stringify(exit)}`);
	return m[1];
};

const FIXED_CLOCK = (): Date => new Date('2026-05-28T12:00:00Z');

const runFetch = (fetcher: AtmosphericTileFetcher, layerDef = modisTerra, time?: string) =>
	Effect.runPromiseExit(
		Effect.gen(function* () {
			const svc = yield* AtmosphericTileService;
			return yield* svc.fetchTile({ layerDef, tile, time });
		}).pipe(Effect.provide(makeAtmosphericTileServiceLive(fetcher, FIXED_CLOCK))),
	);

describe('AtmosphericTileService — happy path', () => {
	it('returns ok with content-type + cache headers for a healthy upstream response', async () => {
		const exit = await runFetch(fakeFetcher(okJpeg()));
		if (exit._tag !== 'Success') throw new Error('expected Success');
		const o = exit.value;
		expect(o.tag).toBe('ok');
		if (o.tag !== 'ok') return;
		expect(o.status).toBe(200);
		expect(o.contentType).toBe('image/jpeg');
		expect(o.cacheControl).toMatch(/max-age=3600|immutable/);
		expect(o.debugHeaders['x-darkmap-atmospheric-layer']).toBe('clouds-modis-terra');
		expect(o.debugHeaders['x-darkmap-atmospheric-outcome']).toBe('ok');
		expect(o.debugHeaders['x-darkmap-atmospheric-status']).toBe('ok');
	});

	it('clamps a high-zoom request to the layer native zoom', async () => {
		const capture: { url?: string } = {};
		const highZ = { z: 15, x: 1024, y: 512 };
		await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* AtmosphericTileService;
				return yield* svc.fetchTile({ layerDef: modisTerra, tile: highZ, time: undefined });
			}).pipe(Effect.provide(makeAtmosphericTileServiceLive(fakeFetcher(okJpeg(), capture), FIXED_CLOCK))),
		);
		// MODIS Terra maxNativeZoom = 9; URL should reflect zoom 9 not 15.
		expect(capture.url).toContain('Level9');
		expect(capture.url).not.toContain('15');
	});

	it('uses the supplied time verbatim when provided', async () => {
		const capture: { url?: string } = {};
		await runFetch(fakeFetcher(okJpeg(), capture), modisTerra, '2024-01-15');
		expect(capture.url).toContain('2024-01-15');
	});

	it('immutable cache for tiles dated > 48h in the past', async () => {
		const exit = await runFetch(fakeFetcher(okJpeg()), modisTerra, '2020-01-01');
		if (exit._tag !== 'Success' || exit.value.tag !== 'ok') throw new Error('expected ok');
		expect(exit.value.cacheControl).toMatch(/immutable/);
	});

	it('default time falls back to yesterday when called before the layer publication lag', async () => {
		const capture: { url?: string } = {};
		// Before 06:00 UTC publication threshold for MODIS Terra → yesterday.
		const earlyClock = (): Date => new Date('2026-05-28T03:00:00Z');
		await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* AtmosphericTileService;
				return yield* svc.fetchTile({ layerDef: modisTerra, tile, time: undefined });
			}).pipe(Effect.provide(makeAtmosphericTileServiceLive(fakeFetcher(okJpeg(), capture), earlyClock))),
		);
		expect(capture.url).toContain('2026-05-27');
	});
});

describe('AtmosphericTileService — no-data classification', () => {
	it('upstream 404 → no-data transparent tile, not 502', async () => {
		const exit = await runFetch(fakeFetcher(status404()));
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.tag).toBe('no-data');
		if (exit.value.tag !== 'no-data') return;
		expect(exit.value.status).toBe(200);
		expect(exit.value.contentType).toBe('image/png');
		expect(exit.value.body.byteLength).toBeGreaterThan(0);
		expect(exit.value.debugHeaders['x-darkmap-atmospheric-outcome']).toBe('no-data');
		expect(exit.value.debugHeaders['x-darkmap-atmospheric-status']).toBe('no-data');
		expect(exit.value.debugHeaders['x-darkmap-atmospheric-upstream-status']).toBe('404');
	});

	it('upstream 204 → no-data, preserves debug headers', async () => {
		const exit = await runFetch(fakeFetcher(status204()));
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.tag).toBe('no-data');
	});

	it('upstream 200 with tiny empty image → no-data', async () => {
		const exit = await runFetch(fakeFetcher(emptyPng()));
		if (exit._tag !== 'Success') throw new Error('expected Success');
		expect(exit.value.tag).toBe('no-data');
	});

	it('no-data response uses a short cache window so retries can re-check soon', async () => {
		const exit = await runFetch(fakeFetcher(status404()));
		if (exit._tag !== 'Success' || exit.value.tag !== 'no-data') throw new Error('expected no-data');
		expect(exit.value.cacheControl).toContain('max-age=600');
	});

	it('falls back to previous dates when the default date has no tile yet', async () => {
		const capture = { urls: [] as string[] };
		const exit = await runFetch(sequenceFetcher([status404(), okJpeg()], capture));
		if (exit._tag !== 'Success' || exit.value.tag !== 'ok') throw new Error('expected fallback ok');

		expect(capture.urls).toHaveLength(2);
		expect(capture.urls[0]).toContain('2026-05-28');
		expect(capture.urls[1]).toContain('2026-05-27');
		expect(exit.value.debugHeaders['x-darkmap-atmospheric-time']).toBe('2026-05-28');
		expect(exit.value.debugHeaders['x-darkmap-atmospheric-source-time']).toBe('2026-05-27');
		expect(exit.value.debugHeaders['x-darkmap-atmospheric-status']).toBe('ok-fallback');
	});

	it('falls back for a RECENT explicit time — the live "now" view pins time=today, which GIBS has not published yet', async () => {
		// Regression for the blank-atmospheric bug: the walk-back used to be gated
		// on `!explicitTime`, but the live map ALWAYS pins time=today, so it never
		// fell back and every overlay rendered an empty no-data tile. A recent
		// explicit date must now walk back to the latest available imagery.
		const capture = { urls: [] as string[] };
		const exit = await runFetch(sequenceFetcher([status404(), okJpeg()], capture), modisTerra, '2026-05-28');
		if (exit._tag !== 'Success' || exit.value.tag !== 'ok') throw new Error('expected recent-explicit fallback ok');

		expect(capture.urls).toHaveLength(2);
		expect(capture.urls[0]).toContain('2026-05-28');
		expect(capture.urls[1]).toContain('2026-05-27');
		expect(exit.value.debugHeaders['x-darkmap-atmospheric-time']).toBe('2026-05-28');
		expect(exit.value.debugHeaders['x-darkmap-atmospheric-source-time']).toBe('2026-05-27');
		expect(exit.value.debugHeaders['x-darkmap-atmospheric-status']).toBe('ok-fallback');
	});

	it('does NOT fall back for an explicit HISTORICAL date — a settled scrub is requested as-is', async () => {
		const capture = { urls: [] as string[] };
		const exit = await runFetch(sequenceFetcher([status404(), okJpeg()], capture), modisTerra, '2020-01-01');
		if (exit._tag !== 'Success' || exit.value.tag !== 'no-data') throw new Error('expected pinned historical no-data');

		expect(capture.urls).toHaveLength(1);
		expect(exit.value.debugHeaders['x-darkmap-atmospheric-time']).toBe('2020-01-01');
		expect(exit.value.debugHeaders['x-darkmap-atmospheric-source-time']).toBe('2020-01-01');
		expect(exit.value.debugHeaders['x-darkmap-atmospheric-status']).toBe('no-data');
	});
});

describe('AtmosphericTileService — failure surface', () => {
	it('upstream 503 surfaces as upstream-error with status', async () => {
		const exit = await runFetch(fakeFetcher(status503()));
		expect(failReason(exit)).toBe('upstream-error');
	});

	it('throws fetch errors surface as fetch-failed', async () => {
		const throwFetcher: AtmosphericTileFetcher = {
			fetch: async () => {
				throw new Error('socket reset');
			},
		};
		const exit = await runFetch(throwFetcher);
		expect(failReason(exit)).toBe('fetch-failed');
	});

	it('layer without a capability row surfaces as no-capability', async () => {
		const unregistered: RasterLayerDef = {
			...modisTerra,
			id: 'unregistered-band',
		};
		const exit = await runFetch(fakeFetcher(okJpeg()), unregistered);
		expect(failReason(exit)).toBe('no-capability');
	});
});
