import { error, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { openAQJson, type ProviderFailure } from '$lib/atmospheric/provider-http';
import {
	HISTORY_POLLUTANT_NAMES,
	shapeHistory,
	type HistoryPollutantName,
	type V3HourlyResult,
} from '$lib/atmospheric/openaq-history-shape';

/**
 * OpenAQ v3 hourly-history proxy (TIN-1754 / V6-2). Holds `OPENAQ_API_KEY`
 * server-side; returns a single pollutant's recent hourly series for a station
 * or point, shaped for the PointReadout sparkline + rolling stats.
 *
 * v3 reality (verified against the OpenAPI spec): there is no bbox-wide hourly
 * history. Hourly aggregates live at `/v3/sensors/{sensors_id}/hours`
 * (HourlyDataResponse: `value`, `parameter{name,units}`, `period{datetimeFrom,
 * datetimeTo}`, coverage, summary). A SENSOR — not a location — is the unit, so:
 *   1. resolve a location: `?locationId` directly, or `?lat&lon` →
 *      `/v3/locations?coordinates=lat,lon&radius=…` (nearest match),
 *   2. read `/v3/locations/{id}` for its `sensors[]` and pick the sensor whose
 *      parameter matches `?param` (default pm25),
 *   3. fetch `/v3/sensors/{sensorId}/hours?datetime_from=…&limit=…`,
 *   4. shape into honest {points, mean, trend} (gaps stay gaps — see
 *      `$lib/atmospheric/openaq-history-shape`).
 *
 * Missing key / 401 → empty `degraded:true` (the sparkline simply doesn't
 * render, not an error). Attribution follows OpenAQ and its upstream providers.
 */

const OPENAQ = 'https://api.openaq.org/v3';
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 72; // cap the window so the /hours fetch stays small
const RADIUS_M = 12000; // nearest-location search radius when given lat/lon (max 25 km)

/** Flat-trend tolerance per pollutant, in the pollutant's own units. */
const FLAT_BAND: Record<HistoryPollutantName, number> = {
	pm25: 1, // µg/m³
	pm10: 2, // µg/m³
	no2: 1, // varies by provider units; ~1 is a conservative deadband
	o3: 1,
	so2: 1,
	co: 0.1,
};

const POLLUTANT_SET = new Set<string>(HISTORY_POLLUTANT_NAMES);

const emptyResult = (reason: ProviderFailure | 'not-configured' | 'no-coverage'): Response =>
	new Response(JSON.stringify({ series: null, degraded: reason !== 'no-coverage', reason }), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=60',
			'x-openaq-degraded': String(reason !== 'no-coverage'),
		},
	});

interface V3LocationLite {
	readonly id?: number;
	readonly sensors?: ReadonlyArray<{ readonly id?: number; readonly parameter?: { readonly name?: string } }>;
}

export const GET: RequestHandler = async ({ url }) => {
	const locationIdStr = url.searchParams.get('locationId');
	const latStr = url.searchParams.get('lat');
	const lonStr = url.searchParams.get('lon');
	const paramRaw = url.searchParams.get('param') ?? 'pm25';
	const hoursRaw = url.searchParams.get('hours');

	if (!POLLUTANT_SET.has(paramRaw)) {
		error(400, `param must be one of: ${HISTORY_POLLUTANT_NAMES.join(', ')}`);
	}
	const param = paramRaw as HistoryPollutantName;

	let hours = DEFAULT_HOURS;
	if (hoursRaw !== null) {
		const h = Number(hoursRaw);
		if (!Number.isInteger(h) || h <= 0) error(400, 'hours must be a positive integer');
		hours = Math.min(h, MAX_HOURS);
	}

	const haveLocationId = locationIdStr !== null && locationIdStr !== '';
	const haveLatLon = latStr !== null && lonStr !== null;
	if (!haveLocationId && !haveLatLon) {
		error(400, 'provide either locationId or lat&lon');
	}

	const apiKey = env.OPENAQ_API_KEY;
	if (!apiKey) return emptyResult('not-configured');

	// 1. Resolve a location id.
	let locationId: number | null = null;
	if (haveLocationId) {
		const n = Number(locationIdStr);
		if (!Number.isInteger(n) || n <= 0) error(400, 'locationId must be a positive integer');
		locationId = n;
	} else {
		const lat = Number(latStr);
		const lon = Number(lonStr);
		if (
			!latStr?.trim() ||
			!lonStr?.trim() ||
			!Number.isFinite(lat) ||
			!Number.isFinite(lon) ||
			Math.abs(lat) > 90 ||
			Math.abs(lon) > 180
		)
			error(400, 'lat/lon must be valid WGS84 coordinates');
		const nearParams = new URLSearchParams({
			coordinates: `${lat.toFixed(5)},${lon.toFixed(5)}`,
			radius: String(RADIUS_M),
			limit: '1',
			parameters_id: '', // left blank; we filter by sensor parameter after fetch
		});
		nearParams.delete('parameters_id');
		const nearBody = await openAQJson<V3LocationLite>(`${OPENAQ}/locations?${nearParams}`, apiKey);
		if (!nearBody.ok) return emptyResult(nearBody.reason);
		const first = nearBody.results[0];
		if (typeof first?.id !== 'number') return emptyResult('no-coverage');
		locationId = first.id;
	}

	// 2. Read the location's sensors and pick the one matching the requested pollutant.
	const locBody = await openAQJson<V3LocationLite>(`${OPENAQ}/locations/${locationId}`, apiKey);
	if (!locBody.ok) return emptyResult(locBody.reason);
	const loc = locBody.results[0];
	const sensor = (loc?.sensors ?? []).find((s) => s.parameter?.name === param && typeof s.id === 'number');
	if (!sensor || typeof sensor.id !== 'number') return emptyResult('no-coverage');

	// 3. Fetch the hourly aggregates over the window.
	const now = Date.now();
	// Stable five-minute windows let simultaneous visitors share the response cache.
	const windowEnd = Math.floor(now / (5 * 60_000)) * 5 * 60_000;
	const windowFrom = new Date(windowEnd - hours * 60 * 60 * 1000).toISOString();
	const windowTo = new Date(windowEnd).toISOString();
	const hoursParams = new URLSearchParams({
		datetime_from: windowFrom,
		datetime_to: windowTo,
		limit: String(MAX_HOURS),
	});
	const hoursBody = await openAQJson<V3HourlyResult>(`${OPENAQ}/sensors/${sensor.id}/hours?${hoursParams}`, apiKey);
	if (!hoursBody.ok) return emptyResult(hoursBody.reason);

	// 4. Shape into an honest series (gaps stay gaps; mean over real samples only).
	const series = shapeHistory({
		results: hoursBody.results ?? [],
		parameter: param,
		windowFrom,
		windowTo,
		nowMs: now,
		staleAfterMs: STALE_AFTER_MS,
		flatBand: FLAT_BAND[param],
	});

	return new Response(JSON.stringify({ series, locationId, sensorId: sensor.id, degraded: false }), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=900, s-maxage=900',
		},
	});
};
