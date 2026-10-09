import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { Cause, Effect, Exit, Option } from 'effect';
import { afterAll, describe, expect, it } from 'vitest';
import { RasterClient, RasterError, type RasterResponse, type RasterTileRequest } from './RasterClient';
import {
	MANIFEST_RECHECK_MS,
	TRANSPARENT_TILE_PNG,
	isPng,
	makeSelfHostedRasterClient,
	resolveSelfHostedTileConfig,
	type SelfHostedTileConfig,
	type SelfHostedTileIo,
} from './SelfHostedTiles';

const BINDING = { path: 'gibs-viirs-black-marble/2016', maxZoom: 8, product: 'NASA GIBS VIIRS_Black_Marble 2016-01-01' };
const LAYERS = [{ upstreamLayer: 'PostGIS:VIIRS_2019', selfHosted: BINDING }, { upstreamLayer: 'PostGIS:WA_2015' }];

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const MANIFEST = JSON.stringify({ schema: 'darkmap-self-hosted-pyramid/v1', max_zoom: 8 });
const BASE = 'https://tiles.example.test/darkmap';
const MANIFEST_URL = `${BASE}/gibs-viirs-black-marble/2016/manifest.json`;

const run = (config: SelfHostedTileConfig, io: SelfHostedTileIo, req: RasterTileRequest) =>
	Effect.runPromiseExit(
		Effect.gen(function* () {
			const client = yield* RasterClient;
			return yield* client.getTile(req);
		}).pipe(Effect.provide(makeSelfHostedRasterClient(config, io))),
	);

const viirsTile = (z: number, x = 74, y = 96): RasterTileRequest => ({
	upstreamLayer: 'PostGIS:VIIRS_2019',
	tile: { z, x, y },
});

const noUpstream = (): Effect.Effect<RasterResponse, RasterError> =>
	Effect.die(new Error('upstream must not be contacted for a self-hosted layer'));

/** A fetch stub serving the manifest plus a per-URL tile table. */
const storeFetch = (tiles: Record<string, Response | (() => Response)>, seen: string[] = []) =>
	(async (input: RequestInfo | URL) => {
		const url = String(input);
		seen.push(url);
		if (url === MANIFEST_URL) return new Response(MANIFEST, { status: 200 });
		const hit = tiles[url];
		if (hit) return typeof hit === 'function' ? hit() : hit;
		return new Response('missing', { status: 404 });
	}) as typeof fetch;

const statusOf = (exit: Exit.Exit<RasterResponse, RasterError>): number | undefined => {
	if (Exit.isSuccess(exit)) return undefined;
	const failure = Cause.findErrorOption(exit.cause);
	return Option.isSome(failure) && failure.value instanceof RasterError ? failure.value.status : undefined;
};

describe('resolveSelfHostedTileConfig', () => {
	it('keeps the bindings but leaves the store unset when the base URL is unset or blank', () => {
		for (const value of [undefined, '  ']) {
			const config = resolveSelfHostedTileConfig(value, LAYERS);
			expect(config.baseUrl).toBeUndefined();
			expect([...config.layers.keys()]).toEqual(['PostGIS:VIIRS_2019']);
		}
	});

	it('binds only layers that declare a self-hosted binding', () => {
		const config = resolveSelfHostedTileConfig(`${BASE}/`, LAYERS);
		expect(config.baseUrl).toBe(BASE);
		expect([...config.layers.keys()]).toEqual(['PostGIS:VIIRS_2019']);
		expect(config.layers.get('PostGIS:VIIRS_2019')).toEqual(BINDING);
	});

	it('rejects plain http, queries, fragments and embedded credentials', () => {
		expect(() => resolveSelfHostedTileConfig('http://tiles.example.test', LAYERS)).toThrow();
		expect(() => resolveSelfHostedTileConfig('https://tiles.example.test/?sig=1', LAYERS)).toThrow();
		expect(() => resolveSelfHostedTileConfig('https://tiles.example.test/#x', LAYERS)).toThrow();
		expect(() => resolveSelfHostedTileConfig('https://user:pw@tiles.example.test', LAYERS)).toThrow();
		expect(() => resolveSelfHostedTileConfig('not a url', LAYERS)).toThrow();
	});
});

describe('makeSelfHostedRasterClient over HTTPS', () => {
	const config = resolveSelfHostedTileConfig(BASE, LAYERS);
	const tileUrl = `${BASE}/gibs-viirs-black-marble/2016/8/74/96.png`;

	it('checks the manifest, then fetches the XYZ path and returns the stored PNG bytes', async () => {
		const seen: string[] = [];
		const exit = await run(
			config,
			{ fetch: storeFetch({ [tileUrl]: () => new Response(PNG_BYTES, { status: 200 }) }, seen), upstream: noUpstream },
			viirsTile(8),
		);
		expect(seen).toEqual([MANIFEST_URL, tileUrl]);
		expect(Exit.isSuccess(exit)).toBe(true);
		if (Exit.isSuccess(exit)) {
			expect(exit.value.contentType).toBe('image/png');
			expect(Array.from(exit.value.body)).toEqual(Array.from(PNG_BYTES));
		}
	});

	it('answers a sparse-pyramid 404 inside a present store with a transparent tile', async () => {
		const exit = await run(config, { fetch: storeFetch({}), upstream: noUpstream }, viirsTile(8));
		expect(Exit.isSuccess(exit)).toBe(true);
		if (Exit.isSuccess(exit)) expect(Array.from(exit.value.body)).toEqual(Array.from(TRANSPARENT_TILE_PNG));
	});

	it('fails with 503 when the store has no manifest, instead of serving blanks (F1)', async () => {
		const seen: string[] = [];
		const fetchStub = (async (input: RequestInfo | URL) => {
			seen.push(String(input));
			return new Response('missing', { status: 404 });
		}) as typeof fetch;
		const exit = await run(config, { fetch: fetchStub, upstream: noUpstream }, viirsTile(8));
		expect(Exit.isFailure(exit)).toBe(true);
		expect(statusOf(exit)).toBe(503);
		expect(seen).toEqual([MANIFEST_URL]);
	});

	it('re-checks a missing manifest only after the re-check interval', async () => {
		let clock = 1_000;
		let manifestCalls = 0;
		let present = false;
		const fetchStub = (async (input: RequestInfo | URL) => {
			if (String(input) === MANIFEST_URL) {
				manifestCalls += 1;
				return present ? new Response(MANIFEST) : new Response('missing', { status: 404 });
			}
			return new Response(PNG_BYTES);
		}) as typeof fetch;
		const layer = makeSelfHostedRasterClient(config, { fetch: fetchStub, upstream: noUpstream, now: () => clock });
		const once = () =>
			Effect.runPromiseExit(
				Effect.gen(function* () {
					return yield* (yield* RasterClient).getTile(viirsTile(8));
				}).pipe(Effect.provide(layer)),
			);
		expect(Exit.isFailure(await once())).toBe(true);
		present = true;
		expect(Exit.isFailure(await once())).toBe(true);
		expect(manifestCalls).toBe(1);
		clock += MANIFEST_RECHECK_MS + 1;
		expect(Exit.isSuccess(await once())).toBe(true);
		expect(manifestCalls).toBe(2);
		expect(Exit.isSuccess(await once())).toBe(true);
		expect(manifestCalls).toBe(2);
	});

	it('does not request tiles deeper than the rendered zoom', async () => {
		const seen: string[] = [];
		const exit = await run(config, { fetch: storeFetch({}, seen), upstream: noUpstream }, viirsTile(9));
		expect(seen.filter((u) => u.endsWith('.png'))).toEqual([]);
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it('fails on a store error or non-PNG bytes, never falling back upstream', async () => {
		for (const response of [
			() => new Response('denied', { status: 403 }),
			() => new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }),
		]) {
			const seen: string[] = [];
			const exit = await run(config, { fetch: storeFetch({ [tileUrl]: response }, seen), upstream: noUpstream }, viirsTile(8));
			expect(seen.every((u) => u.startsWith(`${BASE}/`))).toBe(true);
			expect(Exit.isFailure(exit)).toBe(true);
			expect(statusOf(exit)).toBe(502);
		}
	});

	it('never contacts the upstream for a bound layer when the store is unset', async () => {
		const unset = resolveSelfHostedTileConfig(undefined, LAYERS);
		let fetched = 0;
		const exit = await run(
			unset,
			{
				fetch: (async () => {
					fetched += 1;
					return new Response(PNG_BYTES);
				}) as typeof fetch,
				upstream: noUpstream,
			},
			viirsTile(8),
		);
		expect(fetched).toBe(0);
		expect(Exit.isFailure(exit)).toBe(true);
		expect(statusOf(exit)).toBe(503);
	});

	it('routes unbound layers (World Atlas) to the upstream client, with or without a store (F5)', async () => {
		for (const cfg of [config, resolveSelfHostedTileConfig(undefined, LAYERS)]) {
			const asked: RasterTileRequest[] = [];
			const exit = await run(
				cfg,
				{
					fetch: (async () => {
						throw new Error('store must not be read for an unbound layer');
					}) as typeof fetch,
					upstream: (req) => {
						asked.push(req);
						return Effect.succeed({ contentType: 'image/png', body: PNG_BYTES });
					},
				},
				{ upstreamLayer: 'PostGIS:WA_2015', tile: { z: 1, x: 0, y: 0 } },
			);
			expect(Exit.isSuccess(exit)).toBe(true);
			expect(asked).toEqual([{ upstreamLayer: 'PostGIS:WA_2015', tile: { z: 1, x: 0, y: 0 } }]);
		}
	});
});

describe('makeSelfHostedRasterClient over file://', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'darkmap-tiles-'));
	const empty = mkdtempSync(path.join(tmpdir(), 'darkmap-tiles-empty-'));
	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(empty, { recursive: true, force: true });
	});
	mkdirSync(path.join(root, 'gibs-viirs-black-marble/2016/8/74'), { recursive: true });
	writeFileSync(path.join(root, 'gibs-viirs-black-marble/2016/manifest.json'), MANIFEST);
	writeFileSync(path.join(root, 'gibs-viirs-black-marble/2016/8/74/96.png'), PNG_BYTES);
	const config = resolveSelfHostedTileConfig(pathToFileURL(root).href, LAYERS);

	it('reads a stored tile from the directory', async () => {
		const exit = await run(config, { upstream: noUpstream }, viirsTile(8));
		expect(Exit.isSuccess(exit)).toBe(true);
		if (Exit.isSuccess(exit)) expect(Array.from(exit.value.body)).toEqual(Array.from(PNG_BYTES));
	});

	it('treats a missing file inside a present pyramid as an empty tile', async () => {
		const exit = await run(config, { upstream: noUpstream }, viirsTile(8, 1, 1));
		expect(Exit.isSuccess(exit)).toBe(true);
		if (Exit.isSuccess(exit)) expect(isPng(exit.value.body)).toBe(true);
	});

	it('fails with 503 on an empty or unmounted volume (F1)', async () => {
		const exit = await run(resolveSelfHostedTileConfig(pathToFileURL(empty).href, LAYERS), { upstream: noUpstream }, viirsTile(8));
		expect(Exit.isFailure(exit)).toBe(true);
		expect(statusOf(exit)).toBe(503);
	});

	it('only ever reads integer z/x/y paths under the binding (no traversal)', async () => {
		const reads: string[] = [];
		const exit = await run(
			config,
			{
				upstream: noUpstream,
				readFile: async (p) => {
					reads.push(p);
					return p.endsWith('manifest.json') ? new TextEncoder().encode(MANIFEST) : null;
				},
			},
			viirsTile(3, 2, 5),
		);
		expect(Exit.isSuccess(exit)).toBe(true);
		const prefix = path.join(root, 'gibs-viirs-black-marble/2016');
		expect(reads).toEqual([path.join(prefix, 'manifest.json'), path.join(prefix, '3/2/5.png')]);
	});
});

describe('TRANSPARENT_TILE_PNG', () => {
	it('is a valid 256 x 256 RGBA PNG whose IDAT inflates to fully transparent rows', () => {
		expect(isPng(TRANSPARENT_TILE_PNG)).toBe(true);
		const view = new DataView(TRANSPARENT_TILE_PNG.buffer, TRANSPARENT_TILE_PNG.byteOffset);
		expect(view.getUint32(16)).toBe(256);
		expect(view.getUint32(20)).toBe(256);
		expect(TRANSPARENT_TILE_PNG[24]).toBe(8);
		expect(TRANSPARENT_TILE_PNG[25]).toBe(6);
		const idatLength = view.getUint32(33);
		expect(String.fromCharCode(...TRANSPARENT_TILE_PNG.slice(37, 41))).toBe('IDAT');
		const raw = inflateSync(TRANSPARENT_TILE_PNG.slice(41, 41 + idatLength));
		expect(raw.length).toBe(256 * (1 + 256 * 4));
		expect(raw.every((b) => b === 0)).toBe(true);
		const tail = TRANSPARENT_TILE_PNG.slice(TRANSPARENT_TILE_PNG.length - 12);
		expect(String.fromCharCode(...tail.slice(4, 8))).toBe('IEND');
	});
});
