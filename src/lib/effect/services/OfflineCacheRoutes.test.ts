import { describe, expect, it } from 'vitest';
import { isEphemerisRequestPath, isRasterTileRequestPath, isStaticProjectionRequestPath } from './OfflineCacheRoutes';

describe('OfflineCacheRoutes', () => {
	it('matches the query-string raster API path MapLibre actually requests', () => {
		const url = new URL('https://darkmap.example/api/raster?layer=viirs_2019&z=11&x=623&y=743');
		expect(isRasterTileRequestPath(url.pathname)).toBe(true);
	});

	it('continues to match future path-style raster routes', () => {
		expect(isRasterTileRequestPath('/api/raster/viirs_2019/11/623/743')).toBe(true);
	});

	it('does not treat unrelated API paths as raster tiles', () => {
		expect(isRasterTileRequestPath('/api/rasterize')).toBe(false);
		expect(isRasterTileRequestPath('/api/geocode')).toBe(false);
	});

	it('matches ephemeris and elevation API paths exactly or by child path', () => {
		expect(isEphemerisRequestPath('/api/featureinfo')).toBe(true);
		expect(isEphemerisRequestPath('/api/featureinfo/point')).toBe(true);
		expect(isEphemerisRequestPath('/api/elevation')).toBe(true);
		expect(isEphemerisRequestPath('/api/elevation/tile')).toBe(true);
		expect(isEphemerisRequestPath('/api/elevation-profile')).toBe(false);
	});

	it('matches static projection paths without catching sibling prefixes', () => {
		expect(isStaticProjectionRequestPath('/projection')).toBe(true);
		expect(isStaticProjectionRequestPath('/projection/pulse.json')).toBe(true);
		expect(isStaticProjectionRequestPath('/projectionist')).toBe(false);
	});
});
