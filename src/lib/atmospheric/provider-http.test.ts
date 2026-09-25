import { describe, expect, it, vi } from 'vitest';
import { makeOpenAQClient, nearestForecastHour } from './provider-http';

describe('OpenAQ request resilience', () => {
	it('coalesces duplicate requests and caches only the raw successful results', async () => {
		const fetcher = vi.fn(async () => Response.json({ results: [{ id: 1 }] }));
		const client = makeOpenAQClient(fetcher);
		const results = await Promise.all([client('/locations', 'test-key'), client('/locations', 'test-key')]);
		expect(results).toEqual([
			{ ok: true, results: [{ id: 1 }] },
			{ ok: true, results: [{ id: 1 }] },
		]);
		await client('/locations', 'test-key');
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]).toEqual(['/locations', expect.objectContaining({ signal: expect.any(AbortSignal) })]);
	});

	it('expires metadata and readings after five minutes', async () => {
		let now = 0;
		const fetcher = vi.fn(async () => Response.json({ results: [] }));
		const client = makeOpenAQClient(fetcher, () => now);
		await client('/latest', 'test-key');
		now = 300_000;
		await client('/latest', 'test-key');
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it.each([401, 403, 502])('does not turn HTTP %s into a healthy cached empty list', async (status) => {
		const fetcher = vi.fn(async () => new Response('', { status }));
		const client = makeOpenAQClient(fetcher);
		expect(await client('/latest', 'test-key')).toEqual({
			ok: false,
			reason: status === 502 ? 'unavailable' : 'unauthorized',
		});
		await client('/latest', 'test-key');
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('honors Retry-After across different endpoints without a retry storm', async () => {
		let now = 0;
		const fetcher = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }));
		const client = makeOpenAQClient(fetcher, () => now);
		expect(await client('/locations', 'test-key')).toEqual({ ok: false, reason: 'rate-limited' });
		await client('/history', 'test-key');
		now = 119_999;
		await client('/latest', 'test-key');
		expect(fetcher).toHaveBeenCalledTimes(1);
		now = 120_000;
		await client('/locations', 'test-key');
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('rejects missing or malformed results instead of claiming no coverage', async () => {
		const client = makeOpenAQClient(async () => Response.json({ detail: 'error' }));
		expect(await client('/locations', 'test-key')).toEqual({ ok: false, reason: 'invalid-response' });
	});

	it('honors OpenAQ reset seconds when Retry-After is absent', async () => {
		let now = 0;
		const fetcher = vi.fn(async () => new Response('', { status: 429, headers: { 'x-ratelimit-reset': '3600' } }));
		const client = makeOpenAQClient(fetcher, () => now);
		await client('/locations', 'test-key');
		now = 3_599_000;
		await client('/latest', 'test-key');
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('turns network/timeout failure into an explicit unavailable result', async () => {
		const client = makeOpenAQClient(async () => {
			throw new Error('network');
		});
		expect(await client('/locations', 'test-key')).toEqual({ ok: false, reason: 'unavailable' });
	});

	it('clears cache and cooldown when the operator changes credentials', async () => {
		const fetcher = vi.fn(async () => Response.json({ results: [] }));
		const client = makeOpenAQClient(fetcher);
		await client('/locations', 'key-one');
		await client('/locations', 'key-two');
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});

describe('forecast hour matching', () => {
	const time = Date.parse('2026-09-22T12:00Z');
	it('matches UTC-naive and explicitly UTC timestamps within half an hour', () => {
		expect(nearestForecastHour(['2026-09-22T12:00'], time + 29 * 60_000)).toBe(0);
		expect(nearestForecastHour(['2026-09-22T12:00Z'], time)).toBe(0);
	});
	it('never shows todays forecast for a past or future month', () => {
		expect(nearestForecastHour(['2026-09-22T12:00'], time + 31 * 60_000)).toBeNull();
		expect(nearestForecastHour(['2026-09-22T12:00'], Date.parse('2026-08-22T12:00Z'))).toBeNull();
	});
	it('does not select index zero when all upstream dates are invalid', () => {
		expect(nearestForecastHour(['invalid'], time)).toBeNull();
		expect(nearestForecastHour([], time)).toBeNull();
	});
});
