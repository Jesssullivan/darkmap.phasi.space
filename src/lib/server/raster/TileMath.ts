/**
 * Web Mercator (EPSG:3857) tile math. Translates an XYZ tile coordinate
 * (z, x, y) — what MapLibre's raster source emits — into the bbox
 * format a WMS GetMap request expects (minx, miny, maxx, maxy in
 * meters).
 *
 * Constants from the OGC Web Mercator definition:
 *   - Total extent: ±20037508.342789244 m (half the equatorial
 *     circumference, projected).
 *   - At zoom z, the world is divided into 2^z columns/rows.
 */

const HALF_EQUATOR_M = 20037508.342789244;
const TOTAL_EXTENT_M = HALF_EQUATOR_M * 2;

export interface TileCoord {
	readonly z: number;
	readonly x: number;
	readonly y: number;
}

export interface BBox3857 {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
}

export function tileBBox3857({ z, x, y }: TileCoord): BBox3857 {
	const tileSize = TOTAL_EXTENT_M / Math.pow(2, z);
	const minX = -HALF_EQUATOR_M + x * tileSize;
	const maxX = minX + tileSize;
	const maxY = HALF_EQUATOR_M - y * tileSize;
	const minY = maxY - tileSize;
	return { minX, minY, maxX, maxY };
}

/** Serialize a bbox as `minX,minY,maxX,maxY` for the WMS `bbox=` param. */
export function bboxParam(bbox: BBox3857): string {
	return `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`;
}

export function parseTileCoord(z: string, x: string, y: string): TileCoord {
	const zn = Number.parseInt(z, 10);
	const xn = Number.parseInt(x, 10);
	const yn = Number.parseInt(y, 10);
	if (!Number.isFinite(zn) || !Number.isFinite(xn) || !Number.isFinite(yn)) {
		throw new Error(`invalid tile coord: z=${z} x=${x} y=${y}`);
	}
	if (zn < 0 || zn > 24) throw new Error(`zoom out of range: ${zn}`);
	const max = Math.pow(2, zn);
	if (xn < 0 || xn >= max || yn < 0 || yn >= max) {
		throw new Error(`tile coord out of range for zoom ${zn}: x=${xn} y=${yn}`);
	}
	return { z: zn, x: xn, y: yn };
}

/**
 * Fold a high-zoom XYZ request back to the parent tile supported by a fixed
 * native matrix set. Map renderers can overzoom visually, but GIBS only serves
 * the matrix levels advertised in the layer capabilities.
 */
export function clampTileToMaxNativeZoom(tile: TileCoord, maxNativeZoom: number | undefined): TileCoord {
	if (maxNativeZoom === undefined || tile.z <= maxNativeZoom) return tile;
	const factor = Math.pow(2, tile.z - maxNativeZoom);
	return {
		z: maxNativeZoom,
		x: Math.floor(tile.x / factor),
		y: Math.floor(tile.y / factor),
	};
}
