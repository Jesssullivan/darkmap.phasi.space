import { Effect } from 'effect';
import { error, json } from '@sveltejs/kit';
import { GeocoderClient, GeocoderClientLive, type GeocodeResult } from '$lib/server/geocoder/GeocoderClient';
import { TtlCache } from '$lib/server/geocoder/cache';
import type { RequestHandler } from './$types';

// Per-process LRU+TTL cache. Compresses autocomplete typing patterns
// where the same final query lands many times in a few seconds, and
// makes a 5-minute revisit free for any (q, limit, bias) combination.
const cache = new TtlCache<readonly GeocodeResult[]>({ maxEntries: 256, ttlMs: 5 * 60 * 1000 });

/**
 * Geocode proxy. The browser hits `/api/geocode?q=<text>` and we forward
 * to Photon server-side via the Effect service. This keeps any future
 * API key (or self-hosted Photon URL) off the client bundle and gives
 * us a single spot to layer in caching.
 *
 * Query params:
 *   q     — search text (required, trimmed; empty returns [])
 *   limit — 1..20 (default 8; clamped server-side)
 *   lat   — optional viewport bias latitude
 *   lon   — optional viewport bias longitude
 */
export const GET: RequestHandler = async ({ url }) => {
	const q = url.searchParams.get('q')?.trim() ?? '';
	if (!q) return json({ results: [] });

	const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
	const limit = Math.max(1, Math.min(20, Number.isFinite(limitRaw) ? limitRaw : 8));

	const latStr = url.searchParams.get('lat');
	const lonStr = url.searchParams.get('lon');
	const bias =
		latStr && lonStr
			? (() => {
					const lat = Number.parseFloat(latStr);
					const lon = Number.parseFloat(lonStr);
					return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined;
				})()
			: undefined;

	const cacheKey = `${q}|${limit}|${bias?.lat ?? ''}|${bias?.lon ?? ''}`;
	const cached = cache.get(cacheKey);
	if (cached) {
		return json(
			{ results: cached, attribution: 'Geocoding © OpenStreetMap contributors, via Photon (komoot)' },
			{ headers: { 'x-cache': 'HIT' } },
		);
	}

	const program = Effect.gen(function* () {
		const client = yield* GeocoderClient;
		return yield* client.search({ q, limit, bias });
	}).pipe(Effect.provide(GeocoderClientLive));

	const exit = await Effect.runPromiseExit(program);
	if (exit._tag === 'Failure') {
		throw error(502, 'geocoder upstream failed');
	}
	cache.set(cacheKey, exit.value);
	return json(
		{ results: exit.value, attribution: 'Geocoding © OpenStreetMap contributors, via Photon (komoot)' },
		{ headers: { 'x-cache': 'MISS' } },
	);
};
