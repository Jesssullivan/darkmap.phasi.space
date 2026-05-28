import { error, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

/**
 * OpenAQ v3 PM2.5 proxy. Holds the `OPENAQ_API_KEY` server-side; returns
 * GeoJSON ready for a MapLibre GeoJSON source.
 *
 * When the key is missing or upstream errors, returns an empty
 * FeatureCollection with `degraded: true` so the client overlay degrades
 * silently to "nothing rendered" instead of erroring on first paint.
 *
 * License: OpenAQ data is CC-BY 4.0. Attribution surfaces on the smog
 * overlay's MapLibre attribution chip and the `/docs#atmosphere` page (PR-I).
 */

interface OpenAQLocation {
	readonly id?: number;
	readonly name?: string;
	readonly coordinates?: { readonly latitude?: number; readonly longitude?: number };
	readonly parameters?: ReadonlyArray<{
		readonly id?: number;
		readonly name?: string;
		readonly lastValue?: number;
		readonly latestValue?: number;
		readonly displayName?: string;
	}>;
}

interface OpenAQEnvelope {
	readonly results?: ReadonlyArray<OpenAQLocation>;
	readonly meta?: unknown;
}

const PM25_PARAM_ID = 2;
const MAX_LIMIT = 1000;

const emptyDegraded = (): Response =>
	new Response(JSON.stringify({ type: 'FeatureCollection', features: [], degraded: true }), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=60',
			'x-openaq-degraded': 'true',
		},
	});

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
	if (!apiKey) {
		// Local dev / unconfigured deploy — degrade silently so the overlay
		// just renders nothing instead of throwing on first paint.
		return emptyDegraded();
	}

	const upstreamParams = new URLSearchParams({
		bbox: `${west},${south},${east},${north}`,
		parameters_id: String(PM25_PARAM_ID),
		limit: String(MAX_LIMIT),
	});

	let upstream: Response;
	try {
		upstream = await fetch(`https://api.openaq.org/v3/locations?${upstreamParams}`, {
			headers: { accept: 'application/json', 'x-api-key': apiKey },
		});
	} catch {
		return emptyDegraded();
	}

	if (upstream.status === 401 || upstream.status === 403) {
		// Bad key — same soft degradation as the missing-key path.
		return emptyDegraded();
	}
	if (!upstream.ok) {
		const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
		error(status, `openaq returned ${upstream.status}`);
	}

	let body: OpenAQEnvelope;
	try {
		body = (await upstream.json()) as OpenAQEnvelope;
	} catch (e) {
		error(502, `openaq response not JSON: ${e instanceof Error ? e.message : 'unknown'}`);
	}

	const features = (body.results ?? [])
		.map((loc) => locationToFeature(loc))
		.filter((f): f is OpenAQGeoJsonFeature => f !== null);

	return new Response(JSON.stringify({ type: 'FeatureCollection', features, degraded: false }), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=300, s-maxage=300',
		},
	});
};

interface OpenAQGeoJsonFeature {
	type: 'Feature';
	properties: { locationId?: number; locationName: string; value: number | null };
	geometry: { type: 'Point'; coordinates: [number, number] };
}

const locationToFeature = (loc: OpenAQLocation): OpenAQGeoJsonFeature | null => {
	const lat = loc.coordinates?.latitude;
	const lon = loc.coordinates?.longitude;
	if (typeof lat !== 'number' || typeof lon !== 'number') return null;
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

	let value: number | null = null;
	for (const p of loc.parameters ?? []) {
		if (p.id !== PM25_PARAM_ID && p.name !== 'pm25') continue;
		const v = p.lastValue ?? p.latestValue;
		if (typeof v === 'number' && Number.isFinite(v)) value = v;
		break;
	}

	return {
		type: 'Feature',
		properties: {
			locationId: typeof loc.id === 'number' ? loc.id : undefined,
			locationName: typeof loc.name === 'string' ? loc.name : 'Unknown',
			value,
		},
		geometry: { type: 'Point', coordinates: [lon, lat] },
	};
};
