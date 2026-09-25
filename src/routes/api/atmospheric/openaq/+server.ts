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
import { openAQJson, type ProviderFailure } from '$lib/atmospheric/provider-http';

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
 * Upstream failure → `degraded:true`, distinct from healthy empty coverage.
 * Data attribution/licensing follows OpenAQ and its upstream providers.
 */

const OPENAQ = 'https://api.openaq.org/v3';
const LOCATIONS_LIMIT = 1000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // drop stations/readings older than 24h
const MAX_LATEST_FETCHES = 50; // cap the per-location /latest fan-out (no bbox-wide latest exists)
const LATEST_CONCURRENCY = 6;

const emptyDegraded = (reason: ProviderFailure | 'not-configured'): Response =>
	new Response(JSON.stringify({ type: 'FeatureCollection', features: [], degraded: true, reason }), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=60',
			'x-openaq-degraded': 'true',
		},
	});

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
	const apiKey = env.OPENAQ_API_KEY;
	if (!apiKey) return emptyDegraded('not-configured');

	// TIN-1889 Phase 3 — single-station value on demand (`?locationId=<id>`): the client
	// clicks a station marker and asks for that one station's latest reading. No bbox.
	// Shares the raw response cache with the density-field fan-out, so a clicked station that
	// was just fetched for the field is a pure cache hit (zero upstream calls). Honest:
	// if no fresh value resolves, return the marker (status:stale + lastSeen) — never a
	// fabricated reading.
	const locationIdStr = url.searchParams.get('locationId');
	if (locationIdStr) {
		const id = Number(locationIdStr);
		if (!Number.isInteger(id) || id <= 0) error(400, 'locationId must be a positive integer');
		const meta = await openAQJson<V3Location>(`${OPENAQ}/locations/${id}`, apiKey);
		if (!meta.ok) return emptyDegraded(meta.reason);
		const loc = meta.results[0];
		const latest = loc ? await openAQJson<V3Latest>(`${OPENAQ}/locations/${id}/latest`, apiKey) : null;
		const nowMs = Date.now();
		const feature = loc
			? (buildStationFeature(loc, latest?.ok ? latest.results : [], nowMs, STALE_AFTER_MS) ??
				buildMarkerFeature(loc, nowMs, STALE_AFTER_MS))
			: null;
		return new Response(
			JSON.stringify({
				type: 'FeatureCollection',
				features: feature ? [feature] : [],
				degraded: latest !== null && !latest.ok,
				...(latest && !latest.ok ? { reason: latest.reason } : {}),
			}),
			{
				status: 200,
				headers: {
					'content-type': 'application/json',
					'cache-control': latest && !latest.ok ? 'public, max-age=60' : 'public, max-age=120',
				},
			},
		);
	}

	const bboxStr = url.searchParams.get('bbox');
	if (!bboxStr) error(400, 'missing required param: bbox');
	const parts = bboxStr.split(',').map((s) => (s.trim() ? Number(s) : NaN));
	if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
		error(400, 'bbox must be 4 finite numbers: west,south,east,north');
	}
	const [west, south, east, north] = parts;
	if (west >= east || south >= north || west < -180 || east > 180 || south < -90 || north > 90) {
		error(400, 'bbox must have valid WGS84 bounds with west<east and south<north');
	}

	// 1. Locations in the viewport (metadata + sensors + datetimeLast; no values).
	const locParams = new URLSearchParams({ bbox: `${west},${south},${east},${north}`, limit: String(LOCATIONS_LIMIT) });
	const locBody = await openAQJson<V3Location>(`${OPENAQ}/locations?${locParams}`, apiKey);
	if (!locBody.ok) return emptyDegraded(locBody.reason);

	const nowMs = Date.now();
	const locations = locBody.results;

	// TIN-1889 — station-parity marker mode (`?…&markers=1`): return EVERY in-view
	// location as a marker straight from the cheap bbox-native `/locations` metadata,
	// with NO per-location `/latest` fan-out. This is what the always-on station
	// markers layer uses to match other AQ maps' station coverage; values load on
	// demand (the readout / the smog density field still use the valued path below).
	if (url.searchParams.get('markers') === '1') {
		const markers = buildAllMarkers(locations, nowMs, STALE_AFTER_MS);
		return new Response(JSON.stringify({ type: 'FeatureCollection', features: markers, degraded: false }), {
			status: 200,
			headers: {
				'content-type': 'application/json',
				'cache-control': 'public, max-age=300, s-maxage=300',
			},
		});
	}

	// 2. Pre-filter to fresh criteria-pollutant locations and cap the /latest fan-out.
	const fresh = selectFreshLocations(locations, nowMs, STALE_AFTER_MS, MAX_LATEST_FETCHES);

	// 3. Fetch each location's latest values (bounded concurrency, TTL-cached per id so a
	//    re-pan over the same metro is warm) + 4. join/staleness.
	let failure: ProviderFailure | undefined;
	const features = (
		await mapWithConcurrency(fresh, LATEST_CONCURRENCY, async (loc): Promise<StationFeature | null> => {
			const latest = await openAQJson<V3Latest>(`${OPENAQ}/locations/${loc.id}/latest`, apiKey);
			if (!latest.ok) {
				failure = latest.reason;
				return null;
			}
			return buildStationFeature(loc, latest.results, Date.now(), STALE_AFTER_MS);
		})
	).filter((f): f is StationFeature => f !== null);

	return new Response(
		JSON.stringify({
			type: 'FeatureCollection',
			features,
			degraded: failure !== undefined,
			...(failure ? { reason: failure } : {}),
		}),
		{
			status: 200,
			headers: {
				'content-type': 'application/json',
				'cache-control': failure ? 'public, max-age=60' : 'public, max-age=300, s-maxage=300',
			},
		},
	);
};
