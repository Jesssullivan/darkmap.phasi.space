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
 * Open-Meteo). Routed into the `darkmap-atmospheric-tile` SW bucket so all
 * atmospheric responses share an eviction policy. Tile responses come in
 * via `/api/raster?kind=atmospheric` and use the same bucket.
 */
export const isAtmosphericRequestPath = (pathname: string): boolean =>
	pathname === '/api/atmospheric' || pathname.startsWith('/api/atmospheric/');
