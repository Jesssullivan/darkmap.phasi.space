import { afterEach, describe, expect, it } from 'vitest';
import { GET } from './+server';

const originalFetch = globalThis.fetch;
const event = (time = '2026-09-22T12:00Z'): Parameters<typeof GET>[0] =>
	({ url: new URL(`https://darkmap.test/api/atmospheric/airquality?lat=42&lon=-76&time=${time}`) }) as Parameters<
		typeof GET
	>[0];
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('/api/atmospheric/airquality', () => {
	it('preserves unavailable pollen as null, distinct from zero', async () => {
		globalThis.fetch = async () =>
			Response.json({ hourly: { time: ['2026-09-22T12:00'], pm2_5: [7.7], grass_pollen: [null] } });
		const response = await GET(event());
		expect(await response.json()).toMatchObject({ pm25: 7.7, pm10: null, pollen: { grass: null } });
	});
	it('rejects unsupported timeline dates instead of clamping to current CAMS data', async () => {
		globalThis.fetch = async () => Response.json({ hourly: { time: ['2026-09-22T12:00'], pm2_5: [7.7] } });
		await expect(GET(event('2026-08-22T12:00Z'))).rejects.toMatchObject({ status: 404 });
	});
	it('rejects an invalid upstream time axis', async () => {
		globalThis.fetch = async () => Response.json({ hourly: { time: ['invalid'], pm2_5: [7.7] } });
		await expect(GET(event())).rejects.toMatchObject({ status: 404 });
	});
});
