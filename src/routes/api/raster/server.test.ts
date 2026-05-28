import { afterEach, describe, expect, it } from 'vitest';
import { GET } from './+server';

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
	});
});
