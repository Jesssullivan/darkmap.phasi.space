import { Context, Data, Effect, Layer } from 'effect';

/**
 * GeocoderClient — Effect service wrapping the Photon geocoder
 * (https://photon.komoot.io). Phase 1 calls the public dev server;
 * a future ticket will swap in our self-hosted Photon instance via
 * a Layer flip with no caller-side change.
 *
 * Choice notes (from the SOTA-research tranche):
 *   • Photon over Nominatim — Photon is purpose-built for
 *     search-as-you-type, typo-tolerant, no 1 req/s rate limit
 *   • Proxied via /api/geocode so we never expose any future API key
 *     in the browser bundle (and so we can layer caching server-side)
 *   • Output normalized to a minimal `GeocodeResult[]` shape — keeps
 *     the wire format we expose to the browser stable across geocoder
 *     swaps later
 */

export interface GeocodeResult {
	readonly name: string;
	/** Optional human-readable place context (city / state / country). */
	readonly context: string;
	readonly lat: number;
	readonly lon: number;
	/**
	 * Photon's confidence score. 0..1, higher = better. Useful for
	 * highlighting the top hit in the combobox.
	 */
	readonly score: number;
	/** OSM id + type for downstream cross-reference (osm:way/123456). */
	readonly osm?: string;
}

export interface GeocodeQuery {
	readonly q: string;
	readonly limit?: number;
	/** Optional viewport bias: results near this point rank higher. */
	readonly bias?: { lat: number; lon: number };
}

export class GeocoderError extends Data.TaggedError('GeocoderError')<{
	readonly reason: string;
	readonly status?: number;
	readonly cause?: unknown;
}> {}

export class GeocoderClient extends Context.Tag('@darkmap/GeocoderClient')<
	GeocoderClient,
	{
		readonly search: (q: GeocodeQuery) => Effect.Effect<readonly GeocodeResult[], GeocoderError>;
	}
>() {}

const PHOTON_BASE = 'https://photon.komoot.io/api';

interface PhotonFeature {
	readonly type: 'Feature';
	readonly geometry: { type: 'Point'; coordinates: [number, number] };
	readonly properties: {
		readonly osm_id?: number;
		readonly osm_type?: string;
		readonly name?: string;
		readonly city?: string;
		readonly state?: string;
		readonly country?: string;
		readonly countrycode?: string;
		readonly type?: string;
		readonly osm_value?: string;
		readonly osm_key?: string;
		readonly extent?: [number, number, number, number];
	};
}

interface PhotonResponse {
	readonly type: 'FeatureCollection';
	readonly features: readonly PhotonFeature[];
}

const buildContext = (p: PhotonFeature['properties']): string => {
	const parts = [p.city, p.state, p.country].filter((s): s is string => Boolean(s));
	return parts.join(', ');
};

export const normalizePhotonFeature = (f: PhotonFeature, index: number, total: number): GeocodeResult => {
	const [lon, lat] = f.geometry.coordinates;
	const p = f.properties;
	// Photon doesn't surface a confidence float — derive a pseudo-score
	// from rank order so the UI can highlight the first hit. (1.0 for
	// best, decaying linearly to ~0.1 at the bottom.)
	const score = total <= 1 ? 1 : Math.max(0.1, 1 - (index / Math.max(1, total - 1)) * 0.9);
	return {
		name: p.name ?? '',
		context: buildContext(p),
		lat,
		lon,
		score,
		osm: p.osm_type && p.osm_id ? `osm:${p.osm_type}/${p.osm_id}` : undefined,
	};
};

const buildUrl = (q: GeocodeQuery): URL => {
	const url = new URL(PHOTON_BASE);
	url.searchParams.set('q', q.q);
	url.searchParams.set('limit', String(q.limit ?? 8));
	if (q.bias) {
		url.searchParams.set('lat', String(q.bias.lat));
		url.searchParams.set('lon', String(q.bias.lon));
	}
	return url;
};

export const GeocoderClientLive = Layer.succeed(
	GeocoderClient,
	GeocoderClient.of({
		search: (q) =>
			Effect.gen(function* () {
				if (!q.q.trim()) return [];
				const url = buildUrl(q);
				const res = yield* Effect.tryPromise({
					try: () =>
						fetch(url, {
							headers: { accept: 'application/json' },
						}),
					catch: (cause) => new GeocoderError({ reason: 'fetch to Photon failed', cause }),
				});
				if (!res.ok) {
					return yield* Effect.fail(
						new GeocoderError({
							reason: `Photon returned ${res.status}`,
							status: res.status,
						}),
					);
				}
				const body = yield* Effect.tryPromise({
					try: () => res.json() as Promise<PhotonResponse>,
					catch: (cause) => new GeocoderError({ reason: 'Photon JSON parse failed', cause }),
				});
				return body.features.map((f, i) => normalizePhotonFeature(f, i, body.features.length));
			}),
	}),
);

export const makeGeocoderClientStub = (
	search: (q: GeocodeQuery) => Effect.Effect<readonly GeocodeResult[], GeocoderError>,
): Layer.Layer<GeocoderClient> => Layer.succeed(GeocoderClient, { search });
