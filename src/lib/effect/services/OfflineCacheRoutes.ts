/**
 * URL → cache-bucket classification (#232).
 *
 * The service worker dispatches incoming `fetch` events into per-bucket
 * caches. Historically the bucket choice was inlined into
 * `service-worker.ts` — each `is*RequestPath` helper returned a boolean
 * and the SW combined them with the `?kind=atmospheric` query check.
 *
 * #232 makes the bucket the *return value* of a single classifier so:
 *
 *   1. Query-shaped raster URLs (`/api/raster?kind=atmospheric&z=…`)
 *      end up in `atmospheric-tile`, not `raster-tile`, without the
 *      SW having to know the kind taxonomy.
 *   2. Cache keys are normalized (search-param order, lowercased host)
 *      so functionally-identical URLs share one cache entry instead of
 *      bloating the bucket.
 *   3. The contract is unit-testable without instantiating a
 *      service-worker scope.
 *
 * The legacy boolean helpers are kept for backwards compatibility with
 * `service-worker.ts`; they delegate to the same path predicates the
 * classifier uses internally.
 */

import type { CacheEntryMeta } from './OfflineCacheService';

export type CacheBucket = CacheEntryMeta['bucket'];

/* -------------------------- path predicates -------------------------- */

export const isRasterTileRequestPath = (pathname: string): boolean =>
	pathname === '/api/raster' || pathname.startsWith('/api/raster/');

export const isEphemerisRequestPath = (pathname: string): boolean =>
	pathname === '/api/featureinfo' ||
	pathname.startsWith('/api/featureinfo/') ||
	pathname === '/api/elevation' ||
	pathname.startsWith('/api/elevation/');

export const isStaticProjectionRequestPath = (pathname: string): boolean =>
	pathname === '/projection' || pathname.startsWith('/projection/');

/**
 * Atmospheric non-tile endpoints (currently `/api/atmospheric/point` for
 * Open-Meteo, `/api/atmospheric/openaq` for ground-station PM2.5).
 * Routed into the `atmospheric-tile` bucket so all atmospheric responses
 * share an eviction policy. Tile responses come in via
 * `/api/raster?kind=atmospheric` and use the same bucket.
 */
export const isAtmosphericRequestPath = (pathname: string): boolean =>
	pathname === '/api/atmospheric' || pathname.startsWith('/api/atmospheric/');

/* --------------------------- classification --------------------------- */

/**
 * Look at `url` and decide which SW cache bucket should hold the response.
 *
 * Returns `null` when the URL is not cache-managed (e.g. `/api/geocode`,
 * navigations to the app shell, cross-origin requests).
 *
 * The classifier is pure — it does not look at the response, the request
 * method, or headers. Callers gate on method themselves; only `GET` should
 * reach this code path.
 *
 * Decision order (first match wins):
 *
 *   1. `/api/raster?kind=atmospheric` → `atmospheric-tile`
 *   2. `/api/raster*`                  → `raster-tile`
 *   3. `/api/atmospheric*`             → `atmospheric-tile`
 *   4. `/api/featureinfo*` / `/api/elevation*` → `ephemeris`
 *   5. `/projection*`                  → `static-projection`
 *   6. `/api/geocode*`                 → `null` (varies too widely to cache)
 *   7. `/api/*` (other)                → `null` (unknown API → skip cache)
 *   8. Everything else                 → `null` (handled as app-shell by SW)
 */
export const classifyRequest = (url: URL): CacheBucket | null => {
	if (isRasterTileRequestPath(url.pathname)) {
		return url.searchParams.get('kind') === 'atmospheric' ? 'atmospheric-tile' : 'raster-tile';
	}
	if (isAtmosphericRequestPath(url.pathname)) return 'atmospheric-tile';
	if (isEphemerisRequestPath(url.pathname)) return 'ephemeris';
	if (isStaticProjectionRequestPath(url.pathname)) return 'static-projection';
	return null;
};

/* --------------------------- key normalization --------------------------- */

/**
 * Drop the search-param keys that vary per-request but do not affect the
 * upstream response. None today — kept here as the seam for #233 / #234
 * (e.g. cache-buster query, tracking params).
 */
const VOLATILE_PARAMS: ReadonlySet<string> = new Set([]);

/**
 * Normalize a URL into a stable cache key.
 *
 * - Host is lowercased.
 * - Pathname is preserved (case-sensitive on purpose; static asset paths
 *   are case-sensitive in S3 / CDN).
 * - Search params are sorted alphabetically by key, then by value, so
 *   `?z=4&x=3` and `?x=3&z=4` collapse to one entry.
 * - Volatile params (see above) are dropped before sorting.
 * - The URL fragment (`#hash`) is dropped — browsers never send it
 *   upstream.
 * - Trailing slash on the pathname is preserved if present and stripped
 *   otherwise; we do not coerce because some upstreams disambiguate
 *   `/foo/` vs `/foo`.
 *
 * Returns a string suitable for use as the SW cache key (cache-storage
 * stores under the full Request, but our `OfflineCacheService` snapshot
 * stores the key string).
 */
export const normalizeCacheKey = (url: URL): string => {
	const normalized = new URL(url.toString());
	normalized.hash = '';
	normalized.host = normalized.host.toLowerCase();

	// Collect, drop volatile, then sort by (key, value).
	const entries: Array<[string, string]> = [];
	for (const [k, v] of normalized.searchParams.entries()) {
		if (VOLATILE_PARAMS.has(k)) continue;
		entries.push([k, v]);
	}
	entries.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

	// Rebuild the search string from sorted entries.
	const next = new URLSearchParams();
	for (const [k, v] of entries) next.append(k, v);
	normalized.search = next.toString() ? `?${next.toString()}` : '';

	return normalized.toString();
};
