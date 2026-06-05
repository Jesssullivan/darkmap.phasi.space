import { error, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	buildAllMarkers,
	buildStationFeature,
	selectFreshLocations,
	type StationFeature,
	type V3Latest,
	type V3Location,
} from '$lib/atmospheric/openaq-shape';

/**
 * OpenAQ v3 multi-pollutant proxy (TIN-1757). Holds `OPENAQ_API_KEY` server-side;
 * returns GeoJSON ready for the MapLibre point source + the AQI field.
 *
 * OpenAQ v3 reality: `/locations?bbox` returns `sensors[]` + `datetimeLast` but
 * NO values, and `/parameters/{id}/latest?bbox` ignores the bbox. So we:
 *   1. fetch `/locations?bbox` (metadata),
 *   2. pre-filter to fresh, criteria-pollutant locations and cap the set,
 *   3. fan out bounded-concurrent `/locations/{id}/latest` for the actual values,
 *   4. join + staleness-filter into features (see `$lib/atmospheric/openaq-shape`).
 *
 * Missing key / 401 → empty `degraded:true` (overlay renders nothing, not an error).
 * License: OpenAQ CC-BY 4.0.
 */

const OPENAQ = 'https://api.openaq.org/v3';
const LOCATIONS_LIMIT = 1000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // drop stations/readings older than 24h
const MAX_LATEST_FETCHES = 50; // cap the per-location /latest fan-out (no bbox-wide latest exists)
const LATEST_CONCURRENCY = 6;

const emptyDegraded = (): Response =>
	new Response(JSON.stringify({ type: 'FeatureCollection', features: [], degraded: true }), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=60',
			'x-openaq-degraded': 'true',
		},
	});

const authedJson = async (url: string, apiKey: string): Promise<unknown | null> => {
	try {
		const r = await fetch(url, { headers: { accept: 'application/json', 'x-api-key': apiKey } });
		if (!r.ok) return null;
		return await r.json();
	} catch {
		return null;
	}
};

/** Run `fn` over `items` with at most `limit` in flight. Order-preserving. */
const mapWithConcurrency = async <T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> => {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const idx = next++;
			if (idx >= items.length) return;
			out[idx] = await fn(items[idx]);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return out;
};

export const GET: RequestHandler = async ({ url }) => {
	const bboxStr = url.searchParams.get('bbox');
	if (!bboxStr) error(400, 'missing required param: bbox');
	const parts = bboxStr.split(',').map((s) => Number.parseFloat(s));
	if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
		error(400, 'bbox must be 4 finite numbers: west,south,east,north');
	}
	const [west, south, east, north] = parts;
	if (west >= east || south >= north) {
		error(400, 'bbox must have west<east and south<north');
	}

	const apiKey = env.OPENAQ_API_KEY;
	if (!apiKey) return emptyDegraded();

	// 1. Locations in the viewport (metadata + sensors + datetimeLast; no values).
	const locParams = new URLSearchParams({ bbox: `${west},${south},${east},${north}`, limit: String(LOCATIONS_LIMIT) });
	let locRes: Response;
	try {
		locRes = await fetch(`${OPENAQ}/locations?${locParams}`, {
			headers: { accept: 'application/json', 'x-api-key': apiKey },
		});
	} catch {
		return emptyDegraded();
	}
	if (locRes.status === 401 || locRes.status === 403) return emptyDegraded();
	if (!locRes.ok) {
		const status = locRes.status >= 400 && locRes.status < 600 ? locRes.status : 502;
		error(status, `openaq returned ${locRes.status}`);
	}
	let locBody: { results?: V3Location[] };
	try {
		locBody = (await locRes.json()) as { results?: V3Location[] };
	} catch (e) {
		error(502, `openaq response not JSON: ${e instanceof Error ? e.message : 'unknown'}`);
	}

	const nowMs = Date.now();
	const locations = locBody.results ?? [];

	// TIN-1889 — station-parity marker mode (`?…&markers=1`): return EVERY in-view
	// location as a marker straight from the cheap bbox-native `/locations` metadata,
	// with NO per-location `/latest` fan-out. This is what the always-on station
	// markers layer uses to match other AQ maps' station coverage; values load on
	// demand (the readout / the smog density field still use the valued path below).
	if (url.searchParams.get('markers') === '1') {
		const markers = buildAllMarkers(locations, nowMs, STALE_AFTER_MS);
		return new Response(JSON.stringify({ type: 'FeatureCollection', features: markers, degraded: false }), {
			status: 200,
			headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300, s-maxage=300' },
		});
	}

	// 2. Pre-filter to fresh criteria-pollutant locations and cap the /latest fan-out.
	const fresh = selectFreshLocations(locations, nowMs, STALE_AFTER_MS, MAX_LATEST_FETCHES);

	// 3. Fetch each location's latest values (bounded concurrency) + 4. join/staleness.
	const features = (
		await mapWithConcurrency(fresh, LATEST_CONCURRENCY, async (loc): Promise<StationFeature | null> => {
			const body = (await authedJson(`${OPENAQ}/locations/${loc.id}/latest`, apiKey)) as {
				results?: V3Latest[];
			} | null;
			return buildStationFeature(loc, body?.results ?? [], nowMs, STALE_AFTER_MS);
		})
	).filter((f): f is StationFeature => f !== null);

	return new Response(JSON.stringify({ type: 'FeatureCollection', features, degraded: false }), {
		status: 200,
		headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300, s-maxage=300' },
	});
};
