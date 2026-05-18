import { describe, expect, it } from 'vitest';
import { GET } from './+server';

const fakeEvent = () => ({}) as Parameters<typeof GET>[0];

describe('/healthz', () => {
	it('returns 200 with status=ok', async () => {
		const res = await GET(fakeEvent());
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; uptime_s: number; timestamp: string };
		expect(body.status).toBe('ok');
	});

	it('reports a finite uptime', async () => {
		const res = await GET(fakeEvent());
		const body = (await res.json()) as { uptime_s: number };
		expect(Number.isFinite(body.uptime_s)).toBe(true);
		expect(body.uptime_s).toBeGreaterThanOrEqual(0);
	});

	it('emits an ISO-8601 timestamp', async () => {
		const res = await GET(fakeEvent());
		const body = (await res.json()) as { timestamp: string };
		expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');
	});

	it('sets cache-control: no-store so probes never see a stale answer', async () => {
		const res = await GET(fakeEvent());
		expect(res.headers.get('cache-control')).toBe('no-store');
	});
});
