import { error, type RequestHandler } from '@sveltejs/kit';

/**
 * Open-Meteo Air-Quality (`/v1/air-quality`, CAMS) proxy for PointReadout's
 * pollen + air-quality section (V3-5). Returns a single matched hour shaped to
 * `AirQualityPointReading` so the client doesn't ship the full hourly schema.
 *
 * Honesty: every species/value is `number | null`. CAMS returns `null` for a
 * pollen species that is out of season or unsupported in a region — that is a
 * real "none reported", NOT zero, and the readout renders it as such. We never
 * coerce a missing value to 0.
 *
 * Cache: 1 h browser + CDN; the service worker buckets it into
 * `darkmap-atmospheric-tile` alongside the forecast proxy. CC-BY, no key.
 */

interface AirQualityHourly {
	readonly time?: string[];
	readonly alder_pollen?: (number | null)[];
	readonly birch_pollen?: (number | null)[];
	readonly grass_pollen?: (number | null)[];
	readonly mugwort_pollen?: (number | null)[];
	readonly olive_pollen?: (number | null)[];
	readonly ragweed_pollen?: (number | null)[];
	readonly pm2_5?: (number | null)[];
	readonly pm10?: (number | null)[];
	readonly aerosol_optical_depth?: (number | null)[];
	readonly dust?: (number | null)[];
	readonly ozone?: (number | null)[];
}

interface AirQualityBody {
	readonly hourly?: AirQualityHourly;
}

const HOURLY_VARS = [
	'alder_pollen',
	'birch_pollen',
	'grass_pollen',
	'mugwort_pollen',
	'olive_pollen',
	'ragweed_pollen',
	'pm2_5',
	'pm10',
	'aerosol_optical_depth',
	'dust',
	'ozone',
].join(',');

export const GET: RequestHandler = async ({ url }) => {
	const latStr = url.searchParams.get('lat');
	const lonStr = url.searchParams.get('lon');
	const timeStr = url.searchParams.get('time');
	if (!latStr || !lonStr || !timeStr) {
		error(400, 'missing required params: lat, lon, time');
	}
	const lat = Number.parseFloat(latStr);
	const lon = Number.parseFloat(lonStr);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		error(400, 'lat/lon must be finite numbers');
	}
	const requested = new Date(timeStr);
	if (Number.isNaN(requested.getTime())) {
		error(400, 'invalid time (expected ISO-8601)');
	}

	const upstreamParams = new URLSearchParams({
		latitude: lat.toFixed(4),
		longitude: lon.toFixed(4),
		hourly: HOURLY_VARS,
		timezone: 'UTC',
		past_days: '1',
		forecast_days: '2',
	});

	let upstream: Response;
	try {
		upstream = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${upstreamParams}`, {
			headers: { accept: 'application/json' },
		});
	} catch (e) {
		error(502, `open-meteo air-quality fetch failed: ${e instanceof Error ? e.message : 'unknown'}`);
	}

	if (!upstream.ok) {
		const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
		error(status, `open-meteo air-quality returned ${upstream.status}`);
	}

	let body: AirQualityBody;
	try {
		body = (await upstream.json()) as AirQualityBody;
	} catch (e) {
		error(502, `open-meteo air-quality response not JSON: ${e instanceof Error ? e.message : 'unknown'}`);
	}

	const hourly = body.hourly;
	if (!hourly?.time || hourly.time.length === 0) {
		error(502, 'open-meteo air-quality response missing hourly time axis');
	}

	const targetMs = requested.getTime();
	let bestIdx = 0;
	let bestDelta = Number.POSITIVE_INFINITY;
	for (let i = 0; i < hourly.time.length; i++) {
		const parsed = Date.parse(`${hourly.time[i]}Z`);
		if (!Number.isFinite(parsed)) continue;
		const delta = Math.abs(parsed - targetMs);
		if (delta < bestDelta) {
			bestDelta = delta;
			bestIdx = i;
		}
	}

	const reading = {
		matchedTime: hourly.time[bestIdx],
		pollen: {
			alder: numberOrNull(hourly.alder_pollen, bestIdx),
			birch: numberOrNull(hourly.birch_pollen, bestIdx),
			grass: numberOrNull(hourly.grass_pollen, bestIdx),
			mugwort: numberOrNull(hourly.mugwort_pollen, bestIdx),
			olive: numberOrNull(hourly.olive_pollen, bestIdx),
			ragweed: numberOrNull(hourly.ragweed_pollen, bestIdx),
		},
		pm25: numberOrNull(hourly.pm2_5, bestIdx),
		pm10: numberOrNull(hourly.pm10, bestIdx),
		aod550: numberOrNull(hourly.aerosol_optical_depth, bestIdx),
		dust: numberOrNull(hourly.dust, bestIdx),
		ozone: numberOrNull(hourly.ozone, bestIdx),
	};

	return new Response(JSON.stringify(reading), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=3600, s-maxage=3600',
		},
	});
};

/** Pass real numbers through; everything else (incl. CAMS `null`) becomes `null`. */
const numberOrNull = (values: readonly (number | null)[] | undefined, index: number): number | null => {
	const value = values?.[index];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
};
