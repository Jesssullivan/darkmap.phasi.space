import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './+server';

const originalFetch = globalThis.fetch;

const fakeEvent = (url: string): Parameters<typeof GET>[0] =>
	({
		url: new URL(url),
	}) as Parameters<typeof GET>[0];

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.fetch = originalFetch;
});

describe('/api/raster atmospheric proxy', () => {
	it.each([
		['timeout', 504],
		['body-read', 502],
	] as const)('classifies %s after successful headers without fabricated raster bytes', async (reason, status) => {
		const controller = new AbortController();
		vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
		const broken = new Response(null, { status: 200 });
		Object.defineProperty(broken, 'arrayBuffer', {
			value: async () => {
				if (reason === 'timeout') {
					controller.abort(new DOMException('fixture deadline', 'TimeoutError'));
					throw new DOMException('fixture body aborted', 'AbortError');
				}
				throw new Error('fixture truncated body');
			},
		});
		globalThis.fetch = (async () => broken) as typeof globalThis.fetch;
		const x = reason === 'timeout' ? 76 : 77;
		const response = await GET(fakeEvent(`https://fixture.invalid/api/raster?layer=viirs_2019&z=8&x=${x}&y=96`));
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({
			message: 'upstream raster error',
			code: 'raster-unavailable',
			stage: 'upstream',
			reason,
			upstreamStatus: null,
		});
	});
	it('returns closed upstream denial evidence without upstream address or fabricated bytes', async () => {
		globalThis.fetch = (async () => new Response('', { status: 403 })) as typeof globalThis.fetch;
		const response = await GET(fakeEvent('https://fixture.invalid/api/raster?layer=viirs_2019&z=8&x=75&y=96'));
		expect(response.status).toBe(403);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({ message: 'upstream raster error', code: 'raster-unavailable',
			stage: 'upstream', reason: 'upstream-http', upstreamStatus: 403 });
	});
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
