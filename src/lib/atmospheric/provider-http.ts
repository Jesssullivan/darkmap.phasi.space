/** Bounded, shared per-process OpenAQ requests. Never cache failures as empty data. */
export type ProviderFailure = 'unauthorized' | 'rate-limited' | 'unavailable' | 'invalid-response';
export type ProviderResult<T> = { ok: true; results: T[] } | { ok: false; reason: ProviderFailure };

export const makeOpenAQClient = (fetcher: typeof fetch = (...args) => fetch(...args), now: () => number = Date.now) => {
	const cache = new Map<string, { expires: number; results: unknown[] }>();
	const pending = new Map<string, Promise<ProviderResult<unknown>>>();
	let activeKey = '';
	let retryAt = 0;

	return async <T>(url: string, apiKey: string): Promise<ProviderResult<T>> => {
		if (apiKey !== activeKey) {
			cache.clear();
			pending.clear();
			retryAt = 0;
			activeKey = apiKey;
		}
		const hit = cache.get(url);
		if (hit && hit.expires > now()) return { ok: true, results: hit.results as T[] };
		if (now() < retryAt) return { ok: false, reason: 'rate-limited' };
		const inFlight = pending.get(url);
		if (inFlight) return inFlight as Promise<ProviderResult<T>>;
		const request = (async (): Promise<ProviderResult<unknown>> => {
			try {
				const response = await fetcher(url, {
					headers: { accept: 'application/json', 'x-api-key': apiKey },
					signal: AbortSignal.timeout(8_000),
				});
				if (response.status === 401 || response.status === 403) return { ok: false, reason: 'unauthorized' };
				if (response.status === 429) {
					// OpenAQ documents x-ratelimit-reset as seconds until reset.
					const header = response.headers.get('retry-after') ?? response.headers.get('x-ratelimit-reset');
					const seconds = header === null ? NaN : Number(header);
					const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header ?? '') - now();
					if (activeKey === apiKey) retryAt = now() + Math.max(60_000, Number.isFinite(delay) ? delay : 60_000);
					return { ok: false, reason: 'rate-limited' };
				}
				if (!response.ok) return { ok: false, reason: 'unavailable' };
				const body: unknown = await response.json();
				if (!body || typeof body !== 'object' || !('results' in body) || !Array.isArray(body.results)) {
					return { ok: false, reason: 'invalid-response' };
				}
				if (activeKey === apiKey) {
					cache.delete(url);
					cache.set(url, { expires: now() + 5 * 60_000, results: body.results });
					while (cache.size > 512) cache.delete(cache.keys().next().value!);
				}
				return { ok: true, results: body.results };
			} catch {
				return { ok: false, reason: 'unavailable' };
			}
		})();
		pending.set(url, request);
		try {
			return (await request) as ProviderResult<T>;
		} finally {
			if (pending.get(url) === request) pending.delete(url);
		}
	};
};

// Both viewport and history routes share cooldown, metadata cache and in-flight work.
export const openAQJson = makeOpenAQClient();

/** Open-Meteo UTC hours: do not clamp an arbitrary timeline date to today's forecast. */
export const nearestForecastHour = (times: readonly string[], requestedMs: number): number | null => {
	let best: number | null = null;
	let delta = Number.POSITIVE_INFINITY;
	for (let index = 0; index < times.length; index++) {
		const stamp = times[index];
		const ms = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(stamp) ? stamp : `${stamp}Z`);
		const distance = Math.abs(ms - requestedMs);
		if (distance < delta) {
			delta = distance;
			best = index;
		}
	}
	return delta <= 30 * 60_000 ? best : null;
};
