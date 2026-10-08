import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Effect, Exit } from 'effect';
import { afterAll, describe, expect, it } from 'vitest';
import { RasterClient, RasterError } from './RasterClient';
import {
	TRANSPARENT_TILE_PNG,
	isPng,
	makeSelfHostedRasterClient,
	resolveSelfHostedTileConfig,
	type SelfHostedTileConfig,
} from './SelfHostedTiles';

const LAYERS = [
	{ upstreamLayer: 'PostGIS:VIIRS_2019', selfHostedPath: 'vnp46a4-002/2019', maxNativeZoom: 8 },
	{ upstreamLayer: 'PostGIS:WA_2015' },
];

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const getTile = (config: SelfHostedTileConfig, io: Parameters<typeof makeSelfHostedRasterClient>[1], z: number) =>
	Effect.runPromiseExit(
		Effect.gen(function* () {
			const client = yield* RasterClient;
			return yield* client.getTile({ upstreamLayer: 'PostGIS:VIIRS_2019', tile: { z, x: 74, y: 96 } });
		}).pipe(Effect.provide(makeSelfHostedRasterClient(config, io))),
	);

describe('resolveSelfHostedTileConfig', () => {
	it('is disabled when the base URL is unset or blank', () => {
		expect(resolveSelfHostedTileConfig(undefined, LAYERS)).toBeUndefined();
		expect(resolveSelfHostedTileConfig('  ', LAYERS)).toBeUndefined();
	});

	it('binds only layers that declare a self-hosted path and a native zoom', () => {
		const config = resolveSelfHostedTileConfig('https://tiles.example.test/darkmap/', LAYERS);
		expect(config?.baseUrl).toBe('https://tiles.example.test/darkmap');
		expect([...(config?.layers.keys() ?? [])]).toEqual(['PostGIS:VIIRS_2019']);
		expect(config?.layers.get('PostGIS:VIIRS_2019')).toEqual({ path: 'vnp46a4-002/2019', maxZoom: 8 });
	});

	it('rejects plain http, queries and embedded credentials', () => {
		expect(() => resolveSelfHostedTileConfig('http://tiles.example.test', LAYERS)).toThrow();
		expect(() => resolveSelfHostedTileConfig('https://tiles.example.test/?sig=1', LAYERS)).toThrow();
		expect(() => resolveSelfHostedTileConfig('https://user:pw@tiles.example.test', LAYERS)).toThrow();
		expect(() => resolveSelfHostedTileConfig('not a url', LAYERS)).toThrow();
	});
});

describe('makeSelfHostedRasterClient over HTTPS', () => {
	const config = resolveSelfHostedTileConfig('https://tiles.example.test/darkmap', LAYERS)!;

	it('fetches the XYZ path and returns the stored PNG bytes', async () => {
		const seen: string[] = [];
		const exit = await getTile(
			config,
			{
				fetch: (async (input: RequestInfo | URL) => {
					seen.push(String(input));
					return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
				}) as typeof fetch,
			},
			8,
		);
		expect(seen).toEqual(['https://tiles.example.test/darkmap/vnp46a4-002/2019/8/74/96.png']);
		expect(Exit.isSuccess(exit)).toBe(true);
		if (Exit.isSuccess(exit)) {
			expect(exit.value.contentType).toBe('image/png');
			expect(Array.from(exit.value.body)).toEqual(Array.from(PNG_BYTES));
		}
	});

	it('answers a sparse-pyramid 404 with a transparent tile', async () => {
		const exit = await getTile(
			config,
			{ fetch: (async () => new Response('missing', { status: 404 })) as typeof fetch },
			8,
		);
		expect(Exit.isSuccess(exit)).toBe(true);
		if (Exit.isSuccess(exit)) expect(Array.from(exit.value.body)).toEqual(Array.from(TRANSPARENT_TILE_PNG));
	});

	it('does not request tiles deeper than the rendered zoom', async () => {
		let calls = 0;
		const exit = await getTile(
			config,
			{
				fetch: (async () => {
					calls += 1;
					return new Response(PNG_BYTES);
				}) as typeof fetch,
			},
			9,
		);
		expect(calls).toBe(0);
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it('fails with a RasterError on a store error or non-PNG bytes, never falling back upstream', async () => {
		for (const response of [
			new Response('denied', { status: 403 }),
			new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }),
		]) {
			const seen: string[] = [];
			const exit = await getTile(
				config,
				{
					fetch: (async (input: RequestInfo | URL) => {
						seen.push(String(input));
						return response;
					}) as typeof fetch,
				},
				8,
			);
			expect(seen.every((u) => u.startsWith('https://tiles.example.test/'))).toBe(true);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain('RasterError');
		}
	});
});

describe('makeSelfHostedRasterClient over file://', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'darkmap-tiles-'));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(path.join(root, 'vnp46a4-002/2019/8/74'), { recursive: true });
	writeFileSync(path.join(root, 'vnp46a4-002/2019/8/74/96.png'), PNG_BYTES);
	const config = resolveSelfHostedTileConfig(pathToFileURL(root).href, LAYERS)!;

	it('reads a stored tile from the directory', async () => {
		const exit = await getTile(config, {}, 8);
		expect(Exit.isSuccess(exit)).toBe(true);
		if (Exit.isSuccess(exit)) expect(Array.from(exit.value.body)).toEqual(Array.from(PNG_BYTES));
	});

	it('treats a missing file as an empty tile', async () => {
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const client = yield* RasterClient;
				return yield* client.getTile({ upstreamLayer: 'PostGIS:VIIRS_2019', tile: { z: 8, x: 1, y: 1 } });
			}).pipe(Effect.provide(makeSelfHostedRasterClient(config))),
		);
		expect(Exit.isSuccess(exit)).toBe(true);
		if (Exit.isSuccess(exit)) expect(isPng(exit.value.body)).toBe(true);
	});

	it('rejects an unbound layer', async () => {
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const client = yield* RasterClient;
				return yield* client.getTile({ upstreamLayer: 'PostGIS:WA_2015', tile: { z: 1, x: 0, y: 0 } });
			}).pipe(Effect.provide(makeSelfHostedRasterClient(config))),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		expect(RasterError).toBeDefined();
	});
});

describe('TRANSPARENT_TILE_PNG', () => {
	it('is a PNG with a 256 x 256 RGBA header', () => {
		expect(isPng(TRANSPARENT_TILE_PNG)).toBe(true);
		const view = new DataView(TRANSPARENT_TILE_PNG.buffer, TRANSPARENT_TILE_PNG.byteOffset);
		expect(view.getUint32(16)).toBe(256);
		expect(view.getUint32(20)).toBe(256);
		expect(TRANSPARENT_TILE_PNG[24]).toBe(8);
		expect(TRANSPARENT_TILE_PNG[25]).toBe(6);
	});
});
