/**
 * URL-hash codec for shareable view URLs.
 *
 * Hash format (mirrors common map-app conventions, ours is more
 * compact since we control both ends):
 *
 *   #m=<lat>,<lon>,<zoom>
 *    &l=<id>:<opacity>[,<id>:<opacity>...]
 *    &b=<basemap>
 *    &et=<iso>              -- ephemeris cursor instant
 *    &t=<YYYY-MM>           -- TimeDock monthly-trend cursor (TIN-1301)
 *    &p=1                   -- TimeDock autoplay-on-load flag
 *
 * Examples:
 *   #m=42.4434,-76.5019,9&l=viirs_2019:0.85
 *   #m=42.4434,-76.5019,9&et=2024-12-21T17:00Z
 *   #t=2019-07&p=1
 *
 * Only on-layers appear in `l=`. Opacity is encoded with 2 decimal
 * places. `et=` encodes the ephemeris-overlay cursor as an ISO
 * minute-precision UTC instant (`YYYY-MM-DDTHH:MMZ`). `t=` is the
 * TimeDock month cursor (`YYYY-MM`, distinct from `et=`'s ephemeris
 * instant — one drives the sun/ephemeris overlay, the other drives the
 * VIIRS monthly-trend slider). `p=1` is only meaningful alongside `t=`;
 * it is silently ignored on decode when `t=` is absent or malformed, and
 * omitted on encode when `autoplay` is not `true`. Missing fields are
 * accepted; the caller falls back to its defaults.
 */

import { DEFAULT_LENS, isLens, type Lens } from './lens';

export interface MapView {
	readonly lat: number;
	readonly lon: number;
	readonly zoom: number;
}

export interface HashState {
	readonly view?: MapView;
	/** Active (on) layers + their opacity. Layers absent here are off. */
	readonly layers?: ReadonlyMap<string, number>;
	/** Basemap id (`dark` | `osm` | `satellite`). */
	readonly basemap?: string;
	/** Ephemeris-overlay cursor instant (UTC, minute precision). */
	readonly time?: Date;
	/** Persona lens (`sky` | `air` | `links` | `orbit`); absent ⇒ the `sky` default. */
	readonly lens?: Lens;
	/** TimeDock monthly-trend cursor, `YYYY-MM` (TIN-1301). */
	readonly month?: string;
	/** TimeDock autoplay-on-load flag. Meaningless without `month` set. */
	readonly autoplay?: boolean;
}

/** `YYYY-MM`, Jan-Dec, any 4-digit year — matches the layer manifest's month keys. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

const encodeIsoMinute = (d: Date): string =>
	`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
	`T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;

const round = (n: number, places: number): number => {
	const f = Math.pow(10, places);
	return Math.round(n * f) / f;
};

export function encodeHash(state: HashState): string {
	const parts: string[] = [];
	if (state.view) {
		const { lat, lon, zoom } = state.view;
		parts.push(`m=${round(lat, 4)},${round(lon, 4)},${round(zoom, 2)}`);
	}
	if (state.layers && state.layers.size > 0) {
		const entries = [...state.layers.entries()]
			.map(([id, op]) => `${encodeURIComponent(id)}:${round(op, 2)}`)
			.join(',');
		parts.push(`l=${entries}`);
	}
	if (state.basemap) {
		parts.push(`b=${encodeURIComponent(state.basemap)}`);
	}
	if (state.time) {
		parts.push(`et=${encodeIsoMinute(state.time)}`);
	}
	// Omit the `sky` default — only non-default lenses appear in the hash.
	if (state.lens && state.lens !== DEFAULT_LENS) {
		parts.push(`lens=${state.lens}`);
	}
	if (state.month && MONTH_RE.test(state.month)) {
		parts.push(`t=${state.month}`);
		// `p=` only makes sense paired with a month cursor.
		if (state.autoplay) parts.push('p=1');
	}
	return parts.length === 0 ? '' : `#${parts.join('&')}`;
}

export function decodeHash(hash: string): HashState {
	const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
	if (!trimmed) return {};
	const out: {
		view?: MapView;
		layers?: Map<string, number>;
		basemap?: string;
		time?: Date;
		lens?: Lens;
		month?: string;
		autoplay?: boolean;
	} = {};
	for (const segment of trimmed.split('&')) {
		const eq = segment.indexOf('=');
		if (eq < 0) continue;
		const key = segment.slice(0, eq);
		const value = segment.slice(eq + 1);
		if (key === 'm') {
			const [latStr, lonStr, zoomStr] = value.split(',');
			const lat = Number.parseFloat(latStr);
			const lon = Number.parseFloat(lonStr);
			const zoom = Number.parseFloat(zoomStr);
			if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(zoom)) {
				out.view = { lat, lon, zoom };
			}
		} else if (key === 'l') {
			const map = new Map<string, number>();
			for (const entry of value.split(',')) {
				const colon = entry.indexOf(':');
				if (colon < 0) {
					// Layer present without opacity: treat as default 1.0 on; caller
					// can override with its own default.
					const id = decodeURIComponent(entry);
					if (id) map.set(id, 1);
					continue;
				}
				const id = decodeURIComponent(entry.slice(0, colon));
				const op = Number.parseFloat(entry.slice(colon + 1));
				if (id && Number.isFinite(op)) map.set(id, Math.min(1, Math.max(0, op)));
			}
			if (map.size > 0) out.layers = map;
		} else if (key === 'b') {
			const id = decodeURIComponent(value);
			if (id) out.basemap = id;
		} else if (key === 'et') {
			// Accept either `YYYY-MM-DDTHH:MMZ` (the compact form we emit) or
			// any other ISO-8601 instant — round-tripping a hand-edited URL
			// with seconds/millis is fine.
			const d = new Date(decodeURIComponent(value));
			if (!Number.isNaN(d.getTime())) out.time = d;
		} else if (key === 'lens') {
			const v = decodeURIComponent(value);
			if (isLens(v)) out.lens = v;
		} else if (key === 't') {
			const v = decodeURIComponent(value);
			// Malformed months (bad year width, month out of 01-12, garbage
			// text) fall back to "no cursor" rather than throwing — same
			// contract as every other segment here.
			if (MONTH_RE.test(v)) out.month = v;
		} else if (key === 'p') {
			// Only meaningful paired with `t=`; a stray `p=1` with no month
			// cursor is dropped below rather than surfaced as autoplay with
			// nothing to play.
			if (value === '1') out.autoplay = true;
		}
	}
	// `p=1` without a valid `t=` (whether missing, malformed, or arriving out
	// of order in the hash string) never becomes a live autoplay flag.
	if (out.autoplay && !out.month) delete out.autoplay;
	return out;
}
