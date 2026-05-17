/**
 * Monthly tile prefetch (TIN-1301 sub 5).
 *
 * When the user is viewing VIIRS month N, we kick off background
 * fetches for the tiles that would be needed for month N+1 (and
 * optionally N-1) at the current viewport. Browser HTTP cache holds
 * the responses; when the user scrubs forward, the swap helper's
 * `idle` wait usually resolves in <50 ms because tiles are already
 * in memory.
 *
 * Implementation: spawn `Image()` objects pointing at the tile URLs.
 * The browser fetches them and caches per the `/api/raster` proxy's
 * Cache-Control. The images are never attached to the DOM and are
 * garbage-collected once the fetch resolves.
 *
 * Pure helper modulo the `BoundsAndZoom` boundary so unit tests can
 * exercise it without a real Map instance.
 */

import { lonLatToTilePixel } from './ephemeris/terrarium';

export interface BoundsAndZoom {
	readonly north: number;
	readonly south: number;
	readonly east: number;
	readonly west: number;
	readonly zoom: number;
}

/**
 * Enumerate the (z, x, y) slippy-tile coords covering the given
 * viewport at the requested zoom. Clamps to the world tile range
 * `0..2^z - 1` on both axes and handles antimeridian crossings by
 * splitting the X range into two passes.
 */
export const tilesForViewport = (b: BoundsAndZoom): readonly { z: number; x: number; y: number }[] => {
	const z = Math.max(0, Math.min(20, Math.floor(b.zoom)));
	const n = 2 ** z;
	const max = n - 1;
	const clampY = (y: number) => Math.max(0, Math.min(max, y));
	const wrapX = (x: number) => ((Math.floor(x) % n) + n) % n;

	// Tile y is monotone in latitude (north larger lat → smaller tile y).
	const yNorth = clampY(lonLatToTilePixel(b.north, 0, z).y);
	const ySouth = clampY(lonLatToTilePixel(b.south, 0, z).y);
	const yLo = Math.min(yNorth, ySouth);
	const yHi = Math.max(yNorth, ySouth);

	const xWest = Math.max(0, Math.min(max, lonLatToTilePixel(0, b.west, z).x));
	const xEast = Math.max(0, Math.min(max, lonLatToTilePixel(0, b.east, z).x));

	const out: { z: number; x: number; y: number }[] = [];
	const visit = (x: number, y: number) => out.push({ z, x: wrapX(x), y });

	if (xWest <= xEast) {
		for (let x = xWest; x <= xEast; x++) {
			for (let y = yLo; y <= yHi; y++) visit(x, y);
		}
	} else {
		// Antimeridian crossing: west edge sits east of east edge in tile
		// coords. Walk two strips: [west, max] and [0, east].
		for (let x = xWest; x <= max; x++) {
			for (let y = yLo; y <= yHi; y++) visit(x, y);
		}
		for (let x = 0; x <= xEast; x++) {
			for (let y = yLo; y <= yHi; y++) visit(x, y);
		}
	}
	return out;
};

/** Fire-and-forget HEAD-equivalent fetches for the tile URLs. */
export const prefetchTileUrls = (
	urls: readonly string[],
	imageFactory: () => HTMLImageElement = () => new Image(),
): void => {
	for (const url of urls) {
		const img = imageFactory();
		// `crossOrigin` keeps the fetch in the same credentialed bucket
		// as MapLibre's tile XHR — both end up sharing the same cache key.
		img.crossOrigin = 'anonymous';
		img.src = url;
	}
};

/**
 * Build tile URLs from a template like `/api/raster?layer=foo&z={z}&x={x}&y={y}`
 * for every viewport tile, then issue the prefetches. Returns the
 * count of tiles scheduled (useful for tests).
 */
export const prefetchMonthlyTiles = (
	layerId: string,
	tileUrlTemplate: (layerId: string) => string,
	viewport: BoundsAndZoom,
	imageFactory?: () => HTMLImageElement,
): number => {
	const tiles = tilesForViewport(viewport);
	const template = tileUrlTemplate(layerId);
	const urls = tiles.map((t) =>
		template.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y)),
	);
	prefetchTileUrls(urls, imageFactory);
	return urls.length;
};
