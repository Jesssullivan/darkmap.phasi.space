import { error, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	buildAllMarkers,
	buildMarkerFeature,
	buildStationFeature,
	selectFreshLocations,
	type StationFeature,
	type V3Latest,
	type V3Location,
} from '$lib/atmospheric/openaq-shape';
import { TtlCache } from '$lib/server/geocoder/cache';

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

// TIN-1889 Phase 3 — a per-process latest-index keyed by location id. The per-location
// `/latest` fan-out (for the density field) and the single-station click path share it,
// so a station fetched for one viewport is warm for the next pan and for a click. We
// cache the RAW readings (not the joined feature): buildStationFeature re-derives
// staleness against the CURRENT time, so a reading aging past STALE_AFTER_MS still drops
// even from a warm entry — never paint a now-stale value as fresh. No DB (in-process
// Map + TTL, per the adapter-node contract); each replica warms independently.
const latestCache = new TtlCache<readonly V3Latest[]>({ maxEntries: 512, ttlMs: 5 * 60 * 1000 });

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

/** Cached `/locations/{id}/latest`. Transient failures return [] and are NOT memoized. */
const fetchLatestCached = async (id: number, apiKey: string, nowMs: number): Promise<readonly V3Latest[]> => {
	const key = String(id);
	const hit = latestCache.get(key, nowMs);
	if (hit !== undefined) return hit;
	const body = (await authedJson(`${OPENAQ}/locations/${id}/latest`, apiKey)) as { results?: V3Latest[] } | null;
	if (body === null) return []; // upstream error — empty this pass, not cached
	const results = body.results ?? [];
	latestCache.set(key, results, nowMs);
	return results;
};

export const GET: RequestHandler = async ({ url }) => {
	const apiKey = env.OPENAQ_API_KEY;
	if (!apiKey) return emptyDegraded();

	// TIN-1889 Phase 3 — single-station value on demand (`?locationId=<id>`): the client
	// clicks a station marker and asks for that one station's latest reading. No bbox.
	// Shares the latestCache with the density-field fan-out, so a clicked station that
	// was just fetched for the field is a pure cache hit (zero upstream calls). Honest:
	// if no fresh value resolves, return the marker (status:stale + lastSeen) — never a
	// fabricated reading.
	const locationIdStr = url.searchParams.get('locationId');
	if (locationIdStr) {
		const id = Number.parseInt(locationIdStr, 10);
		if (!Number.isInteger(id) || id <= 0) error(400, 'locationId must be a positive integer');
		const nowMs = Date.now();
		const meta = (await authedJson(`${OPENAQ}/locations/${id}`, apiKey)) as { results?: V3Location[] } | null;
		const loc = meta?.results?.[0];
		const feature = loc
			? (buildStationFeature(loc, await fetchLatestCached(id, apiKey, nowMs), nowMs, STALE_AFTER_MS) ??
				buildMarkerFeature(loc, nowMs, STALE_AFTER_MS))
			: null;
		return new Response(
			JSON.stringify({ type: 'FeatureCollection', features: feature ? [feature] : [], degraded: false }),
			{ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=120' } },
		);
	}

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

	// 3. Fetch each location's latest values (bounded concurrency, TTL-cached per id so a
	//    re-pan over the same metro is warm) + 4. join/staleness.
	const features = (
		await mapWithConcurrency(fresh, LATEST_CONCURRENCY, async (loc): Promise<StationFeature | null> => {
			const latest = await fetchLatestCached(loc.id as number, apiKey, nowMs);
			return buildStationFeature(loc, latest, nowMs, STALE_AFTER_MS);
		})
	).filter((f): f is StationFeature => f !== null);

	return new Response(JSON.stringify({ type: 'FeatureCollection', features, degraded: false }), {
		status: 200,
		headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300, s-maxage=300' },
	});
};
