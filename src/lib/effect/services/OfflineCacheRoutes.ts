export const isRasterTileRequestPath = (pathname: string): boolean =>
	pathname === '/api/raster' || pathname.startsWith('/api/raster/');

export const isEphemerisRequestPath = (pathname: string): boolean =>
	pathname === '/api/featureinfo' ||
	pathname.startsWith('/api/featureinfo/') ||
	pathname === '/api/elevation' ||
	pathname.startsWith('/api/elevation/');

export const isStaticProjectionRequestPath = (pathname: string): boolean =>
	pathname === '/projection' || pathname.startsWith('/projection/');
