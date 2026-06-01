import { error, type RequestHandler } from '@sveltejs/kit';
import { epochAgeDays, parseTleSets, tleEpoch, type TleSet } from '$lib/orbit';
import { TtlCache } from '$lib/server/geocoder/cache';

/**
 * Celestrak TLE proxy (S3 — Orbit lens). Thin adapter-node proxy: fetches a
 * Celestrak GP group (or a single NORAD catalog number) and returns normalized
 * sets + per-set epoch age, so the client never hits Celestrak directly (CORS,
 * rate limits) and the Orbit panel can flag SGP4 staleness.
 *
 * Celestrak asks consumers NOT to poll hard — we cache each query for 2 h in
 * module scope. A bad query / upstream error returns `degraded:true` empty
 * (the panel says "no elements", not an error). TLEs are public-domain
 * (US Space Force) via Celestrak.
 */

const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';
// Allowlisted GROUP names (https://celestrak.org/NORAD/elements/index.php).
const GROUP_ALLOWLIST = new Set([
	'stations',
	'active',
	'visual',
	'last-30-days',
	'amateur',
	'noaa',
	'goes',
	'weather',
	'science',
	'cubesat',
	'gps-ops',
	'galileo',
	'gnss',
	'starlink',
]);
const MAX_SETS = 200;
const TTL_MS = 2 * 60 * 60 * 1000;

interface CachedSet extends TleSet {
	readonly epochIso: string;
}
const cache = new TtlCache<readonly CachedSet[]>({ ttlMs: TTL_MS, maxEntries: 64 });

const respond = (
	sets: readonly CachedSet[],
	meta: { group?: string; catnr?: string; degraded: boolean; cache: 'hit' | 'miss' },
): Response => {
	const now = Date.now();
	const body = {
		source: 'celestrak',
		group: meta.group,
		catnr: meta.catnr,
		fetchedAt: new Date(now).toISOString(),
		degraded: meta.degraded,
		// epoch age is recomputed per-response so a cache hit never reports a stale age.
		sets: sets.map((s) => ({
			name: s.name,
			line1: s.line1,
			line2: s.line2,
			epochIso: s.epochIso,
			epochAgeDays: Number(epochAgeDays(new Date(s.epochIso), new Date(now)).toFixed(2)),
		})),
	};
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=1800, s-maxage=7200',
			'x-orbit-tle-cache': meta.cache,
			...(meta.degraded ? { 'x-orbit-tle-degraded': 'true' } : {}),
		},
	});
};

export const GET: RequestHandler = async ({ url }) => {
	const catnr = url.searchParams.get('catnr');
	const group = url.searchParams.get('group');

	let query: string;
	let cacheKey: string;
	let meta: { group?: string; catnr?: string };
	if (catnr !== null) {
		if (!/^\d{1,9}$/.test(catnr)) error(400, 'catnr must be a NORAD catalog number (1–9 digits)');
		query = `CATNR=${catnr}&FORMAT=tle`;
		cacheKey = `catnr:${catnr}`;
		meta = { catnr };
	} else {
		const g = group ?? 'stations';
		if (!GROUP_ALLOWLIST.has(g)) {
			error(400, `group must be one of: ${[...GROUP_ALLOWLIST].join(', ')}`);
		}
		query = `GROUP=${g}&FORMAT=tle`;
		cacheKey = `group:${g}`;
		meta = { group: g };
	}

	const cached = cache.get(cacheKey);
	if (cached) return respond(cached, { ...meta, degraded: false, cache: 'hit' });

	let text: string;
	try {
		const r = await fetch(`${CELESTRAK}?${query}`, { headers: { accept: 'text/plain' } });
		if (r.status === 429 || r.status >= 500) return respond([], { ...meta, degraded: true, cache: 'miss' });
		if (!r.ok) error(r.status >= 400 && r.status < 500 ? r.status : 502, `celestrak returned ${r.status}`);
		text = await r.text();
	} catch {
		return respond([], { ...meta, degraded: true, cache: 'miss' });
	}

	// Celestrak signals a bad/empty query with a plaintext notice or an HTML page.
	if (!text || /no gp data found/i.test(text) || text.trimStart().startsWith('<')) {
		return respond([], { ...meta, degraded: true, cache: 'miss' });
	}

	const sets: CachedSet[] = parseTleSets(text)
		.slice(0, MAX_SETS)
		.map((s) => ({ ...s, epochIso: tleEpoch(s.line1).toISOString() }));
	if (sets.length === 0) return respond([], { ...meta, degraded: true, cache: 'miss' });

	cache.set(cacheKey, sets);
	return respond(sets, { ...meta, degraded: false, cache: 'miss' });
};
