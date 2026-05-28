import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './+server';

const originalFetch = globalThis.fetch;

const fakeEvent = (url: string): Parameters<typeof GET>[0] =>
	({
		url: new URL(url),
	}) as Parameters<typeof GET>[0];

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.useRealTimers();
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
		expect(res.headers.get('cache-control')).toContain('max-age=300');
		expect(res.headers.get('x-darkmap-atmospheric-time')).toBe('2026-01-01');
		expect(res.headers.get('x-darkmap-atmospheric-source-time')).toBe('2026-01-01');
		expect(res.headers.get('x-darkmap-atmospheric-status')).toBe('no-data');
		expect(res.headers.get('x-darkmap-atmospheric-upstream-status')).toBe('404');
		expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
	});

	it('falls back to previous atmospheric dates when the default date is not published yet', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-28T16:00:00.000Z'));

		const upstreamUrls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			upstreamUrls.push(String(input));
			if (upstreamUrls.length === 1) {
				return new Response('not ready', { status: 404 });
			}
			return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
				status: 200,
				headers: { 'content-type': 'image/png' },
			});
		}) as typeof globalThis.fetch;

		const res = await GET(
			fakeEvent('https://darkmap.test/api/raster?layer=water-vapor-airs&z=7&x=38&y=45&kind=atmospheric'),
		);

		expect(res.status).toBe(200);
		expect(upstreamUrls).toHaveLength(2);
		expect(upstreamUrls[0]).toContain('/default/2026-05-28/');
		expect(upstreamUrls[1]).toContain('/default/2026-05-27/');
		expect(res.headers.get('x-darkmap-atmospheric-time')).toBe('2026-05-28');
		expect(res.headers.get('x-darkmap-atmospheric-source-time')).toBe('2026-05-27');
		expect(res.headers.get('x-darkmap-atmospheric-status')).toBe('ok-fallback');
	});

	it('does not fallback to another date when the atmospheric time is explicit', async () => {
		const upstreamUrls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			upstreamUrls.push(String(input));
			return new Response('not ready', { status: 404 });
		}) as typeof globalThis.fetch;

		const res = await GET(
			fakeEvent(
				'https://darkmap.test/api/raster?layer=water-vapor-airs&z=7&x=38&y=45&kind=atmospheric&time=2026-05-28',
			),
		);

		expect(res.status).toBe(200);
		expect(upstreamUrls).toHaveLength(1);
		expect(res.headers.get('x-darkmap-atmospheric-time')).toBe('2026-05-28');
		expect(res.headers.get('x-darkmap-atmospheric-source-time')).toBe('2026-05-28');
		expect(res.headers.get('x-darkmap-atmospheric-status')).toBe('no-data');
	});
});
