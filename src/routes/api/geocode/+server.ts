import { Effect } from 'effect';
import { error, json } from '@sveltejs/kit';
import { GeocoderClient, GeocoderClientLive } from '$lib/server/geocoder/GeocoderClient';
import type { RequestHandler } from './$types';

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

	const program = Effect.gen(function* () {
		const client = yield* GeocoderClient;
		return yield* client.search({ q, limit, bias });
	}).pipe(Effect.provide(GeocoderClientLive));

	const exit = await Effect.runPromiseExit(program);
	if (exit._tag === 'Failure') {
		throw error(502, 'geocoder upstream failed');
	}
	return json({ results: exit.value });
};
