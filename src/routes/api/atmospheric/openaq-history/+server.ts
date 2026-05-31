import { error, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
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
 * render, not an error). License: OpenAQ CC-BY 4.0.
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

const emptyDegraded = (): Response =>
	new Response(JSON.stringify({ series: null, degraded: true }), {
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
		const h = Number.parseInt(hoursRaw, 10);
		if (!Number.isFinite(h) || h <= 0) error(400, 'hours must be a positive integer');
		hours = Math.min(h, MAX_HOURS);
	}

	const haveLocationId = locationIdStr !== null && locationIdStr !== '';
	const haveLatLon = latStr !== null && lonStr !== null;
	if (!haveLocationId && !haveLatLon) {
		error(400, 'provide either locationId or lat&lon');
	}

	const apiKey = env.OPENAQ_API_KEY;
	if (!apiKey) return emptyDegraded();

	// 1. Resolve a location id.
	let locationId: number | null = null;
	if (haveLocationId) {
		const n = Number.parseInt(locationIdStr as string, 10);
		if (!Number.isFinite(n)) error(400, 'locationId must be an integer');
		locationId = n;
	} else {
		const lat = Number.parseFloat(latStr as string);
		const lon = Number.parseFloat(lonStr as string);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) error(400, 'lat/lon must be finite numbers');
		const nearParams = new URLSearchParams({
			coordinates: `${lat.toFixed(5)},${lon.toFixed(5)}`,
			radius: String(RADIUS_M),
			limit: '1',
			parameters_id: '', // left blank; we filter by sensor parameter after fetch
		});
		nearParams.delete('parameters_id');
		const nearBody = (await authedJson(`${OPENAQ}/locations?${nearParams}`, apiKey)) as {
			results?: V3LocationLite[];
		} | null;
		const first = nearBody?.results?.[0];
		if (typeof first?.id !== 'number') return emptyDegraded(); // no station nearby → nothing to chart
		locationId = first.id;
	}

	// 2. Read the location's sensors and pick the one matching the requested pollutant.
	const locBody = (await authedJson(`${OPENAQ}/locations/${locationId}`, apiKey)) as {
		results?: V3LocationLite[];
	} | null;
	const loc = locBody?.results?.[0];
	const sensor = (loc?.sensors ?? []).find((s) => s.parameter?.name === param && typeof s.id === 'number');
	if (!sensor || typeof sensor.id !== 'number') return emptyDegraded(); // station doesn't measure this pollutant

	// 3. Fetch the hourly aggregates over the window.
	const now = Date.now();
	const windowFrom = new Date(now - hours * 60 * 60 * 1000).toISOString();
	const windowTo = new Date(now).toISOString();
	const hoursParams = new URLSearchParams({
		datetime_from: windowFrom,
		datetime_to: windowTo,
		limit: String(MAX_HOURS),
	});
	const hoursBody = (await authedJson(`${OPENAQ}/sensors/${sensor.id}/hours?${hoursParams}`, apiKey)) as {
		results?: V3HourlyResult[];
	} | null;
	if (hoursBody === null) return emptyDegraded(); // upstream hiccup — degrade, don't error the readout

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
