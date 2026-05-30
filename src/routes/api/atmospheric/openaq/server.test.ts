import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted((): { OPENAQ_API_KEY?: string } => ({ OPENAQ_API_KEY: 'test-key' }));

vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));

import { GET } from './+server';

const originalFetch = globalThis.fetch;

const fakeEvent = (url: string): Parameters<typeof GET>[0] =>
	({
		url: new URL(url),
	}) as Parameters<typeof GET>[0];

const location = (id: number, value: number | null) => ({
	id,
	name: `Station ${id}`,
	coordinates: { latitude: 40 + id / 1000, longitude: -73 - id / 1000 },
	parameters: [
		value === null
			? { id: 2, name: 'pm25', displayName: 'PM2.5' }
			: { id: 2, name: 'pm25', displayName: 'PM2.5', lastValue: value },
	],
});

beforeEach(() => {
	mockEnv.OPENAQ_API_KEY = 'test-key';
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('/api/atmospheric/openaq', () => {
	it('soft-degrades with metadata when OPENAQ_API_KEY is missing', async () => {
		mockEnv.OPENAQ_API_KEY = undefined;
		const fetchSpy = vi.fn();
		globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

		const res = await GET(fakeEvent('https://darkmap.test/api/atmospheric/openaq?bbox=-77,42,-76,43'));
		const body = (await res.json()) as {
			readonly degraded: boolean;
			readonly features: readonly unknown[];
			readonly meta: { readonly degraded: boolean; readonly numericCount: number; readonly nullCount: number };
		};

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(res.status).toBe(200);
		expect(res.headers.get('x-openaq-degraded')).toBe('true');
		expect(body.degraded).toBe(true);
		expect(body.features).toHaveLength(0);
		expect(body.meta).toMatchObject({ degraded: true, numericCount: 0, nullCount: 0 });
	});

	it('reports mixed numeric/null reading counts and station properties', async () => {
		let upstreamUrl = '';
		let upstreamKey = '';
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			upstreamUrl = String(input);
			upstreamKey = String((init?.headers as Record<string, string>)['x-api-key']);
			return new Response(
				JSON.stringify({
					meta: { found: 2 },
					results: [location(1, 12.5), location(2, null), { id: 3, name: 'Bad', coordinates: {} }],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			);
		}) as typeof globalThis.fetch;

		const res = await GET(fakeEvent('https://darkmap.test/api/atmospheric/openaq?bbox=-77,42,-76,43'));
		const body = (await res.json()) as {
			readonly degraded: boolean;
			readonly features: ReadonlyArray<{
				readonly properties: {
					readonly value: number | null;
					readonly hasReading: boolean;
					readonly parameterName: string;
				};
			}>;
			readonly meta: {
				readonly featureCount: number;
				readonly numericCount: number;
				readonly nullCount: number;
				readonly capped: boolean;
				readonly upstreamFound: number;
			};
		};

		expect(upstreamUrl).toContain('https://api.openaq.org/v3/locations?');
		expect(upstreamUrl).toContain('bbox=-77%2C42%2C-76%2C43');
		expect(upstreamUrl).toContain('parameters_id=2');
		expect(upstreamKey).toBe('test-key');
		expect(body.degraded).toBe(false);
		expect(body.features).toHaveLength(2);
		expect(body.features[0].properties).toMatchObject({ value: 12.5, hasReading: true, parameterName: 'pm25' });
		expect(body.features[1].properties).toMatchObject({ value: null, hasReading: false, parameterName: 'pm25' });
		expect(body.meta).toMatchObject({
			featureCount: 2,
			numericCount: 1,
			nullCount: 1,
			capped: false,
			upstreamFound: 2,
		});
	});

	it('keeps all-null viewport responses distinct from upstream degradation', async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ results: [location(1, null), location(2, null)] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})) as typeof globalThis.fetch;

		const res = await GET(fakeEvent('https://darkmap.test/api/atmospheric/openaq?bbox=-77,42,-76,43'));
		const body = (await res.json()) as {
			readonly degraded: boolean;
			readonly meta: { readonly featureCount: number; readonly numericCount: number; readonly nullCount: number };
		};

		expect(body.degraded).toBe(false);
		expect(body.meta).toMatchObject({ featureCount: 2, numericCount: 0, nullCount: 2 });
	});

	it('marks result sets capped when the proxy reaches the OpenAQ limit', async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					meta: { found: 1200 },
					results: Array.from({ length: 1000 }, (_, i) => location(i + 1, 5 + (i % 10))),
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)) as typeof globalThis.fetch;

		const res = await GET(fakeEvent('https://darkmap.test/api/atmospheric/openaq?bbox=-125,25,-66,50'));
		const body = (await res.json()) as {
			readonly features: readonly unknown[];
			readonly meta: {
				readonly featureCount: number;
				readonly numericCount: number;
				readonly nullCount: number;
				readonly capped: boolean;
				readonly upstreamFound: number;
			};
		};

		expect(body.features).toHaveLength(1000);
		expect(body.meta).toMatchObject({
			featureCount: 1000,
			numericCount: 1000,
			nullCount: 0,
			capped: true,
			upstreamFound: 1200,
		});
	});
});
