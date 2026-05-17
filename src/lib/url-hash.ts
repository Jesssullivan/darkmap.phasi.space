/**
 * URL-hash codec for shareable view URLs.
 *
 * Hash format (mirrors common map-app conventions, ours is more
 * compact since we control both ends):
 *
 *   #m=<lat>,<lon>,<zoom>&l=<id>:<opacity>[,<id>:<opacity>...]
 *
 * Examples:
 *   #m=42.4434,-76.5019,9&l=viirs_2019:0.85
 *   #m=40.7128,-74.0060,11&l=viirs_2015:0.5,world_atlas_2015:0.9
 *
 * Only on-layers appear in `l=`. Opacity is encoded with 2 decimal
 * places. Missing fields are accepted; the caller falls back to its
 * defaults.
 */

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
}

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
	return parts.length === 0 ? '' : `#${parts.join('&')}`;
}

export function decodeHash(hash: string): HashState {
	const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
	if (!trimmed) return {};
	const out: { view?: MapView; layers?: Map<string, number>; basemap?: string } = {};
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
		}
	}
	return out;
}
