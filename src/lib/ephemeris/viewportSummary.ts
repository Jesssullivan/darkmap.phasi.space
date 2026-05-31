import type { EphemerisReadout } from './EphemerisClient';

export interface ViewportBounds {
	readonly north: number;
	readonly south: number;
	readonly east: number;
	readonly west: number;
}

export interface GridPoint {
	readonly lat: number;
	readonly lon: number;
}

export type EphemerisEventKey =
	| 'astronomicalDawn'
	| 'nauticalDawn'
	| 'civilDawn'
	| 'sunrise'
	| 'solarNoon'
	| 'sunset'
	| 'civilDusk'
	| 'nauticalDusk'
	| 'astronomicalDusk';

export type EventRange = { readonly min: Date; readonly max: Date };
export type EventRangeMap = Partial<Record<EphemerisEventKey, EventRange>>;

export const EPHEMERIS_EVENT_KEYS: readonly EphemerisEventKey[] = [
	'astronomicalDawn',
	'nauticalDawn',
	'civilDawn',
	'sunrise',
	'solarNoon',
	'sunset',
	'civilDusk',
	'nauticalDusk',
	'astronomicalDusk',
];

export type EphemerisViewportSummaryMode = 'geometric';

export interface EphemerisViewportSummaryRequest {
	readonly canonicalBounds: ViewportBounds;
	readonly key: string;
	readonly mode: EphemerisViewportSummaryMode;
	readonly samplePoints: readonly GridPoint[];
	readonly tileCover: TileCover;
	readonly utcDay: string;
}

export interface TileCover {
	readonly xRanges: readonly TileRange[];
	readonly yRange: TileRange;
	readonly z: number;
}

export interface TileRange {
	readonly from: number;
	readonly to: number;
}

interface MakeSummaryRequestOptions {
	readonly bounds: ViewportBounds;
	readonly mapZoom?: number;
	readonly mode?: EphemerisViewportSummaryMode;
	readonly samples?: number;
	readonly time: Date;
}

const VERSION = 1;
const MIN_SUMMARY_TILE_ZOOM = 5;
const MAX_SUMMARY_TILE_ZOOM = 8;
const WEB_MERCATOR_LAT_LIMIT = 85.05112878;

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

const canonicalizeLon = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;

const viewportGridPoints = (bounds: ViewportBounds, samples: number): readonly GridPoint[] => {
	if (samples < 1) return [];
	const dlat = bounds.north - bounds.south;
	const dlon = bounds.east >= bounds.west ? bounds.east - bounds.west : bounds.east - bounds.west + 360;
	if (dlat <= 0 || dlon <= 0) return [];

	const out: GridPoint[] = [];
	for (let i = 0; i < samples; i++) {
		for (let j = 0; j < samples; j++) {
			const lat = bounds.south + ((i + 0.5) / samples) * dlat;
			const rawLon = bounds.west + ((j + 0.5) / samples) * dlon;
			out.push({ lat, lon: canonicalizeLon(rawLon) });
		}
	}
	return out;
};

const utcDayKey = (t: Date): string => {
	const year = t.getUTCFullYear();
	const month = String(t.getUTCMonth() + 1).padStart(2, '0');
	const day = String(t.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
};

/**
 * Summary zoom is deliberately coarser than the map zoom. The bottom
 * rail is a viewport-level geometric summary, so small phone pans should
 * stay inside the same cache entry while selected pins/GPS fixes keep
 * using precise observer-specific ephemeris.
 */
export const ephemerisSummaryTileZoom = (mapZoom: number | undefined): number => {
	if (mapZoom === undefined || !Number.isFinite(mapZoom)) return MAX_SUMMARY_TILE_ZOOM;
	if (mapZoom < 5) return 5;
	if (mapZoom < 8) return 6;
	if (mapZoom < 11) return 7;
	return MAX_SUMMARY_TILE_ZOOM;
};

const lonToTileX = (lon: number, z: number): number => {
	const n = 2 ** z;
	const normalized = canonicalizeLon(lon);
	const tileLon = normalized === -180 && lon > 0 ? 180 : normalized;
	return clamp(Math.floor(((tileLon + 180) / 360) * n), 0, n - 1);
};

const latToTileY = (lat: number, z: number): number => {
	const n = 2 ** z;
	const safeLat = clamp(lat, -WEB_MERCATOR_LAT_LIMIT, WEB_MERCATOR_LAT_LIMIT);
	const rad = (safeLat * Math.PI) / 180;
	return clamp(Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n), 0, n - 1);
};

const tileXToLon = (x: number, z: number): number => (x / 2 ** z) * 360 - 180;

const tileYToLat = (y: number, z: number): number => {
	const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
	return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

export const webMercatorTileBounds = ({ x, y, z }: { readonly x: number; readonly y: number; readonly z: number }) => ({
	north: tileYToLat(y, z),
	south: tileYToLat(y + 1, z),
	east: canonicalizeLon(tileXToLon(x + 1, z)),
	west: canonicalizeLon(tileXToLon(x, z)),
});

export const tileCoverForBounds = (bounds: ViewportBounds, z: number): TileCover | null => {
	if (bounds.north <= bounds.south) return null;
	const zoom = clamp(Math.trunc(z), MIN_SUMMARY_TILE_ZOOM, MAX_SUMMARY_TILE_ZOOM);
	const n = 2 ** zoom;
	const yNorth = latToTileY(bounds.north, zoom);
	const ySouth = latToTileY(bounds.south, zoom);
	const yRange = { from: Math.min(yNorth, ySouth), to: Math.max(yNorth, ySouth) };
	const lonSpan = bounds.east >= bounds.west ? bounds.east - bounds.west : bounds.east - bounds.west + 360;
	if (lonSpan >= 360) return { z: zoom, xRanges: [{ from: 0, to: n - 1 }], yRange };
	const westX = lonToTileX(bounds.west, zoom);
	const eastX = lonToTileX(bounds.east, zoom);
	const xRanges =
		bounds.east >= bounds.west
			? [{ from: Math.min(westX, eastX), to: Math.max(westX, eastX) }]
			: [
					{ from: westX, to: n - 1 },
					{ from: 0, to: eastX },
				];
	return { z: zoom, xRanges, yRange };
};

const canonicalBoundsForTileCover = (cover: TileCover): ViewportBounds => {
	const n = 2 ** cover.z;
	if (cover.xRanges.length === 1 && cover.xRanges[0].from === 0 && cover.xRanges[0].to === n - 1) {
		return {
			north: tileYToLat(cover.yRange.from, cover.z),
			south: tileYToLat(cover.yRange.to + 1, cover.z),
			east: 180,
			west: -180,
		};
	}
	const first = cover.xRanges[0];
	const last = cover.xRanges[cover.xRanges.length - 1];
	const west = canonicalizeLon(tileXToLon(first.from, cover.z));
	const east = canonicalizeLon(tileXToLon(last.to + 1, cover.z));
	return {
		north: tileYToLat(cover.yRange.from, cover.z),
		south: tileYToLat(cover.yRange.to + 1, cover.z),
		east,
		west,
	};
};

const rangeKey = (range: TileRange): string =>
	range.from === range.to ? String(range.from) : `${range.from}-${range.to}`;

export const tileCoverKey = (cover: TileCover): string =>
	`z${cover.z}:x${cover.xRanges.map(rangeKey).join(',')}:y${rangeKey(cover.yRange)}`;

export const makeEphemerisViewportSummaryRequest = ({
	bounds,
	mapZoom,
	mode = 'geometric',
	samples = 4,
	time,
}: MakeSummaryRequestOptions): EphemerisViewportSummaryRequest | null => {
	const tileCover = tileCoverForBounds(bounds, ephemerisSummaryTileZoom(mapZoom));
	if (!tileCover) return null;
	const canonicalBounds = canonicalBoundsForTileCover(tileCover);
	const samplePoints = viewportGridPoints(canonicalBounds, samples);
	if (samplePoints.length === 0) return null;
	const utcDay = utcDayKey(time);
	return {
		canonicalBounds,
		key: `ephem-range:v${VERSION}:${mode}:${utcDay}:${tileCoverKey(tileCover)}:s${samples}`,
		mode,
		samplePoints,
		tileCover,
		utcDay,
	};
};

export const summarizeEventRanges = (readouts: readonly EphemerisReadout[]): EventRangeMap => {
	const next: EventRangeMap = {};
	for (const k of EPHEMERIS_EVENT_KEYS) {
		let min = Infinity;
		let max = -Infinity;
		for (const r of readouts) {
			const d = r.events[k];
			if (!d) continue;
			const t = d.getTime();
			if (t < min) min = t;
			if (t > max) max = t;
		}
		if (Number.isFinite(min) && Number.isFinite(max)) {
			next[k] = { min: new Date(min), max: new Date(max) };
		}
	}
	return next;
};
