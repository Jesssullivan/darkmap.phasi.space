/**
 * AWS Mapzen Terrarium elevation tiles.
 *
 * Tiles live at `s3://elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` and
 * also at the HTTPS endpoint `https://s3.amazonaws.com/elevation-tiles-
 * prod/terrarium/{z}/{x}/{y}.png`. EPSG:3857 (Web Mercator), 256x256.
 *
 * Each pixel encodes elevation in meters as:
 *
 *   elevation_m = (R * 256 + G + B / 256) - 32768
 *
 * The -32768 offset handles ocean depths down to -32 km.
 *
 * Tile coords are standard XYZ slippy-tile (Y increases southward, top-left
 * is (0, 0) at z=0).
 */

/** Decode a single RGB pixel triplet to elevation in meters. */
export const decodeTerrariumElevation = (r: number, g: number, b: number): number => r * 256 + g + b / 256 - 32768;

/** Standard XYZ tile coords for a lat/lon at a given zoom. */
export interface TilePixel {
	readonly z: number;
	readonly x: number; // tile x
	readonly y: number; // tile y
	readonly px: number; // pixel x within the 256x256 tile (0..255)
	readonly py: number; // pixel y within the 256x256 tile (0..255)
}

/**
 * Project a lat/lon to a Terrarium tile + pixel at zoom `z`. Uses the
 * standard Web Mercator slippy-tile formula:
 *
 *   x = ((lon + 180) / 360) * 2^z
 *   y = ((1 - ln(tan(lat) + sec(lat)) / pi) / 2) * 2^z
 */
export const lonLatToTilePixel = (lat: number, lon: number, z: number): TilePixel => {
	const n = 2 ** z;
	const latRad = (lat * Math.PI) / 180;
	const xf = ((lon + 180) / 360) * n;
	const yf = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
	const xTile = Math.floor(xf);
	const yTile = Math.floor(yf);
	// Each tile is 256 px wide. The fractional part within the tile becomes
	// the pixel offset.
	const px = Math.max(0, Math.min(255, Math.floor((xf - xTile) * 256)));
	const py = Math.max(0, Math.min(255, Math.floor((yf - yTile) * 256)));
	return { z, x: xTile, y: yTile, px, py };
};

/**
 * Move (latitude, longitude) by `distanceMeters` along the great circle
 * at compass bearing `bearingDeg` (clockwise from true north). Returns
 * the destination point.
 *
 * Uses the spherical-earth approximation (R = 6371 km), which has <0.5%
 * error vs. WGS-84 for the few-km hops the horizon raycaster needs.
 */
export const destinationPoint = (
	lat: number,
	lon: number,
	bearingDeg: number,
	distanceMeters: number,
): { lat: number; lon: number } => {
	const R = 6_371_000; // meters
	const lat1 = (lat * Math.PI) / 180;
	const lon1 = (lon * Math.PI) / 180;
	const brg = (bearingDeg * Math.PI) / 180;
	const dr = distanceMeters / R;
	const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(brg));
	const lon2 =
		lon1 + Math.atan2(Math.sin(brg) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
	return { lat: (lat2 * 180) / Math.PI, lon: (((lon2 * 180) / Math.PI + 540) % 360) - 180 };
};
