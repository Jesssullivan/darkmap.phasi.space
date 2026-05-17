/**
 * Browser-side ElevationLookup backed by Terrarium PNG tiles fetched
 * through the `/api/elevation` proxy. Tile pixel data is cached in
 * memory once decoded — at z=12 (~9.5 km/tile at the equator) a single
 * raycaster pin's ray fan rarely needs more than ~25 tiles, so an
 * unbounded Map is fine for the foreseeable future.
 */

import { Effect, Layer } from 'effect';
import type { LatLon } from './EphemerisClient';
import { ElevationLookup, HorizonError } from './HorizonProvider';
import { decodeTerrariumElevation, lonLatToTilePixel } from './terrarium';

/**
 * Default zoom for raycaster lookups. z=12 ~= 9.5 km / tile at the
 * equator, ~5 km in mid-latitudes. Enough resolution for the
 * 25-km horizon ray fan without blowing tile budget.
 */
const DEFAULT_Z = 12;

interface TilePixels {
	readonly data: Uint8ClampedArray;
}

const tileKey = (z: number, x: number, y: number): string => `${z}/${x}/${y}`;

type Tile2DContext = Pick<CanvasRenderingContext2D, 'drawImage' | 'getImageData'>;

const fetchTilePixels = async (z: number, x: number, y: number): Promise<TilePixels> => {
	const res = await fetch(`/api/elevation?z=${z}&x=${x}&y=${y}`);
	if (!res.ok) throw new Error(`elevation tile ${z}/${x}/${y} → ${res.status}`);
	const blob = await res.blob();
	const bmp = await createImageBitmap(blob);
	let ctx: Tile2DContext | null;
	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(256, 256);
		ctx = canvas.getContext('2d', { willReadFrequently: true }) as Tile2DContext | null;
	} else {
		const canvas = document.createElement('canvas');
		canvas.width = 256;
		canvas.height = 256;
		ctx = canvas.getContext('2d', { willReadFrequently: true });
	}
	if (!ctx) throw new Error('2d context unavailable for elevation tile decode');
	ctx.drawImage(bmp, 0, 0);
	const { data } = ctx.getImageData(0, 0, 256, 256);
	bmp.close?.();
	return { data };
};

/** Live ElevationLookup. Uses module-level Map for cross-component caching. */
export const TerrariumElevationLookupLive = Layer.sync(ElevationLookup, () => {
	const cache = new Map<string, Promise<TilePixels>>();
	return {
		metersAt: (loc: LatLon) =>
			Effect.tryPromise({
				try: async () => {
					const { z, x, y, px, py } = lonLatToTilePixel(loc.lat, loc.lon, DEFAULT_Z);
					const key = tileKey(z, x, y);
					let promise = cache.get(key);
					if (!promise) {
						promise = fetchTilePixels(z, x, y);
						cache.set(key, promise);
					}
					const tile = await promise;
					// RGBA → row-major, 4 bytes per pixel.
					const idx = (py * 256 + px) * 4;
					return decodeTerrariumElevation(tile.data[idx], tile.data[idx + 1], tile.data[idx + 2]);
				},
				catch: (cause) =>
					new HorizonError({
						reason: 'TerrariumElevationLookup failed to fetch or decode tile',
						cause,
					}),
			}),
	};
});
