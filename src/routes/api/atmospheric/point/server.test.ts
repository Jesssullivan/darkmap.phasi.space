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

describe('/api/atmospheric/point', () => {
	it('does not request unsupported Open-Meteo PWV and returns PWV as unavailable', async () => {
		let requestedUrl = '';
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requestedUrl = String(input);
			return new Response(
				JSON.stringify({
					hourly: {
						time: ['2026-05-28T14:00', '2026-05-28T15:00', '2026-05-28T16:00'],
						relative_humidity_2m: [66, 74, 69],
						cloud_cover_low: [7, 12, 37],
						cloud_cover_mid: [0, 0, 0],
						cloud_cover_high: [0, 0, 0],
						visibility: [27_300, 21_500, 24_400],
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		}) as typeof globalThis.fetch;

		const res = await GET(
			fakeEvent('https://darkmap.test/api/atmospheric/point?lat=42.1850&lon=-76.7182&time=2026-05-28T15:23:25.591Z'),
		);

		expect(res.status).toBe(200);
		expect(requestedUrl).toContain('relative_humidity_2m');
		expect(requestedUrl).not.toContain('precipitable_water');
		const body = (await res.json()) as {
			readonly matchedTime: string;
			readonly pwv: number | null;
			readonly rh: number;
			readonly cloudLow: number;
			readonly visibility: number;
		};
		expect(body).toMatchObject({
			matchedTime: '2026-05-28T15:00',
			pwv: null,
			rh: 74,
			cloudLow: 12,
			visibility: 21_500,
		});
	});
});
