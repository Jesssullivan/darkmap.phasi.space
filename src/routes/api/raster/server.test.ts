import { afterEach, describe, expect, it } from 'vitest';
import { GET, _resetRasterRuntimeForTests } from './+server';

const originalFetch = globalThis.fetch;

const fakeEvent = (url: string): Parameters<typeof GET>[0] =>
	({
		url: new URL(url),
	}) as Parameters<typeof GET>[0];

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('/api/raster atmospheric proxy', () => {
	it('clamps overzoomed water-vapor requests to the native GIBS matrix tile', async () => {
		let upstreamUrl = '';
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			upstreamUrl = String(input);
			return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
				status: 200,
				headers: { 'content-type': 'image/png' },
			});
		}) as typeof globalThis.fetch;

		const res = await GET(
			fakeEvent(
				'https://darkmap.test/api/raster?layer=water-vapor-airs&z=7&x=38&y=45&kind=atmospheric&time=2026-05-27',
			),
		);

		expect(res.status).toBe(200);
		expect(upstreamUrl).toContain('/MODIS_Terra_Water_Vapor_5km_Day/default/2026-05-27/');
		expect(upstreamUrl).toContain('/GoogleMapsCompatible_Level6/6/22/19.png');
		expect(res.headers.get('x-darkmap-atmospheric-request-tile')).toBe('7/38/45');
		expect(res.headers.get('x-darkmap-atmospheric-native-tile')).toBe('6/19/22');
		expect(res.headers.get('x-darkmap-atmospheric-status')).toBe('ok');
		expect(res.headers.get('x-darkmap-atmospheric-source-time')).toBe('2026-05-27');
	});

	it('returns a transparent no-data tile for an explicitly missing atmospheric time', async () => {
		const upstreamUrls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			upstreamUrls.push(String(input));
			return new Response('<ExceptionReport />', {
				status: 404,
				headers: { 'content-type': 'text/xml' },
			});
		}) as typeof globalThis.fetch;

		const res = await GET(
			fakeEvent(
				'https://darkmap.test/api/raster?layer=water-vapor-airs&z=7&x=38&y=45&kind=atmospheric&time=2026-01-01',
			),
		);

		expect(res.status).toBe(200);
		expect(upstreamUrls).toHaveLength(1);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('cache-control')).toContain('max-age=600');
		expect(res.headers.get('x-darkmap-atmospheric-time')).toBe('2026-01-01');
		expect(res.headers.get('x-darkmap-atmospheric-source-time')).toBe('2026-01-01');
		expect(res.headers.get('x-darkmap-atmospheric-status')).toBe('no-data');
		expect(res.headers.get('x-darkmap-atmospheric-upstream-status')).toBe('404');
		expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
	});
});

describe('/api/raster self-hosted VIIRS slot (RV1/RV12/RV13)', () => {
	const ENV = 'DARKMAP_RASTER_TILE_BASE_URL';
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
	const STORE = 'https://tiles.darkmap.test/raster';
	const SLOT = `${STORE}/vnp46a4-002/2019`;

	const useStore = (tiles: Record<string, () => Response>, requested: string[]) => {
		process.env[ENV] = STORE;
		_resetRasterRuntimeForTests();
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			requested.push(url);
			if (url === `${SLOT}/manifest.json`) return new Response('{"schema":"darkmap-self-hosted-pyramid/v1"}');
			return tiles[url]?.() ?? new Response('', { status: 404 });
		}) as typeof globalThis.fetch;
	};

	afterEach(() => {
		delete process.env[ENV];
		_resetRasterRuntimeForTests();
	});

	it('serves the stored VNP46A4 2019 tile as image/png, labelled with its real product', async () => {
		const requested: string[] = [];
		useStore(
			{
				[`${SLOT}/8/74/96.png`]: () =>
					new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'set-cookie': 'x=1' } }),
			},
			requested,
		);

		const res = await GET(fakeEvent('https://darkmap.test/api/raster?layer=viirs_2019&z=8&x=74&y=96'));

		expect(requested).toEqual([`${SLOT}/manifest.json`, `${SLOT}/8/74/96.png`]);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('cache-control')).toContain('max-age=');
		expect(res.headers.get('x-darkmap-raster-source')).toBe('self-hosted');
		expect(res.headers.get('x-darkmap-raster-product')).toContain('VNP46A4.002 2019');
		expect(res.headers.get('x-darkmap-raster-product')).not.toContain('GIBS');
		expect(res.headers.get('set-cookie')).toBeNull();
		expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(PNG));
	});

	it('answers an unrendered tile inside a present store with a transparent PNG', async () => {
		useStore({}, []);
		const res = await GET(fakeEvent('https://darkmap.test/api/raster?layer=viirs_2019&z=3&x=0&y=0'));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(new Uint8Array(await res.arrayBuffer())[1]).toBe(0x50);
	});

	it('returns 503 for the slot when the store has no manifest (no blank 200)', async () => {
		process.env[ENV] = STORE;
		_resetRasterRuntimeForTests();
		globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof globalThis.fetch;
		await expect(
			GET(fakeEvent('https://darkmap.test/api/raster?layer=viirs_2019&z=8&x=74&y=96')),
		).rejects.toMatchObject({ status: 503 });
	});

	it('returns 503 for the slot when the store is unset, without contacting any upstream', async () => {
		_resetRasterRuntimeForTests();
		const requested: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requested.push(String(input));
			return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
		}) as typeof globalThis.fetch;
		await expect(
			GET(fakeEvent('https://darkmap.test/api/raster?layer=viirs_2019&z=8&x=74&y=96')),
		).rejects.toMatchObject({ status: 503 });
		expect(requested).toEqual([]);
	});

	it('keeps the upstream WMS for unbound layers whether or not the store is set (F5)', async () => {
		for (const store of [undefined, STORE]) {
			if (store) process.env[ENV] = store;
			else delete process.env[ENV];
			_resetRasterRuntimeForTests();
			const requested: string[] = [];
			globalThis.fetch = (async (input: RequestInfo | URL) => {
				requested.push(String(input));
				return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
			}) as typeof globalThis.fetch;

			const res = await GET(fakeEvent('https://darkmap.test/api/raster?layer=world_atlas_2015&z=2&x=1&y=1'));

			expect(res.status).toBe(200);
			expect(res.headers.get('x-darkmap-raster-source')).toBe('upstream-wms');
			expect(res.headers.get('x-darkmap-raster-product')).toBeNull();
			expect(requested).toHaveLength(1);
			expect(new URL(requested[0]).hostname).toBe('www2.lightpollutionmap.info');
			expect(new URL(requested[0]).searchParams.get('layers')).toBe('PostGIS:WA_2015');
		}
	});
});
