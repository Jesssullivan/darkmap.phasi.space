import { error, type RequestHandler } from '@sveltejs/kit';
import { nearestForecastHour } from '$lib/atmospheric/provider-http';

/**
 * Open-Meteo `/v1/forecast` proxy for PointReadout's atmospheric section.
 * Returns a single matched forecast hour shaped to AtmosphericPointReading
 * so the client doesn't have to ship the full hourly schema.
 *
 * Cache: 1 h on browser + CDN (`max-age=3600, s-maxage=3600`). The service
 * worker buckets responses into `darkmap-atmospheric-tile` so eviction can
 * drain atmospheric responses without touching the QueryRaster cache.
 *
 * License: Open-Meteo is CC-BY 4.0, no key required. Attribution lands in
 * the PointReadout section and the `/docs#atmosphere` page (PR-I).
 */

interface OpenMeteoHourly {
	readonly time?: string[];
	readonly relative_humidity_2m?: number[];
	readonly cloud_cover_low?: number[];
	readonly cloud_cover_mid?: number[];
	readonly cloud_cover_high?: number[];
	readonly visibility?: number[];
	readonly wind_speed_10m?: number[];
	readonly wind_direction_10m?: number[];
}

interface OpenMeteoBody {
	readonly hourly?: OpenMeteoHourly;
}

export const GET: RequestHandler = async ({ url }) => {
	const latStr = url.searchParams.get('lat');
	const lonStr = url.searchParams.get('lon');
	const timeStr = url.searchParams.get('time');
	if (!latStr || !lonStr || !timeStr) {
		error(400, 'missing required params: lat, lon, time');
	}
	const lat = Number(latStr);
	const lon = Number(lonStr);
	if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
		error(400, 'lat/lon must be valid WGS84 coordinates');
	}
	const requested = new Date(timeStr);
	if (Number.isNaN(requested.getTime())) {
		error(400, 'invalid time (expected ISO-8601)');
	}

	const upstreamParams = new URLSearchParams({
		latitude: lat.toFixed(4),
		longitude: lon.toFixed(4),
		hourly:
			'relative_humidity_2m,cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility,wind_speed_10m,wind_direction_10m',
		timezone: 'UTC',
		wind_speed_unit: 'ms',
		past_days: '1',
		forecast_days: '2',
	});

	let upstream: Response;
	try {
		upstream = await fetch(`https://api.open-meteo.com/v1/forecast?${upstreamParams}`, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(8_000),
		});
	} catch (e) {
		error(502, `open-meteo fetch failed: ${e instanceof Error ? e.message : 'unknown'}`);
	}

	if (!upstream.ok) {
		const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
		error(status, `open-meteo returned ${upstream.status}`);
	}

	let body: OpenMeteoBody;
	try {
		body = (await upstream.json()) as OpenMeteoBody;
	} catch (e) {
		error(502, `open-meteo response not JSON: ${e instanceof Error ? e.message : 'unknown'}`);
	}

	const hourly = body.hourly;
	if (!hourly?.time || !hourly.relative_humidity_2m || !hourly.visibility || hourly.time.length === 0) {
		error(502, 'open-meteo response missing required hourly fields');
	}

	const bestIdx = nearestForecastHour(hourly.time, requested.getTime());
	if (bestIdx === null) error(404, 'requested time is outside available weather forecast coverage');

	const rh = numberAt(hourly.relative_humidity_2m, bestIdx);
	const visibility = numberAt(hourly.visibility, bestIdx);
	const cloudLow = numberAt(hourly.cloud_cover_low, bestIdx);
	const cloudMid = numberAt(hourly.cloud_cover_mid, bestIdx);
	const cloudHigh = numberAt(hourly.cloud_cover_high, bestIdx);
	if (
		rh === undefined ||
		visibility === undefined ||
		cloudLow === undefined ||
		cloudMid === undefined ||
		cloudHigh === undefined
	) {
		error(502, 'open-meteo response missing required hourly values');
	}

	const reading = {
		matchedTime: hourly.time[bestIdx],
		pwv: null,
		rh,
		cloudLow,
		cloudMid,
		cloudHigh,
		visibility,
		// AQ-4 — surface 10 m wind so the PM2.5 kernel can orient downwind.
		// Explicitly requested m/s above; Open-Meteo defaults to km/h.
		// Nullable: upstream may omit these for some grids; the client falls back
		// to isotropic diffusion when either is null.
		windSpeed: numberAt(hourly.wind_speed_10m, bestIdx) ?? null,
		windDirectionDeg: numberAt(hourly.wind_direction_10m, bestIdx) ?? null,
	};

	return new Response(JSON.stringify(reading), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=3600, s-maxage=3600',
		},
	});
};

const numberAt = (values: readonly number[] | undefined, index: number): number | undefined => {
	const value = values?.[index];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};
