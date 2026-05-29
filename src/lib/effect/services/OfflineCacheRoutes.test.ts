import { describe, expect, it } from 'vitest';
import {
	classifyRequest,
	isEphemerisRequestPath,
	isRasterTileRequestPath,
	isStaticProjectionRequestPath,
	normalizeCacheKey,
} from './OfflineCacheRoutes';

/* -------------------------- legacy path predicates -------------------------- */

describe('OfflineCacheRoutes — path predicates', () => {
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

/* ------------------------------ classifier ------------------------------ */

describe('classifyRequest — bucket dispatch', () => {
	const u = (s: string): URL => new URL(s, 'https://darkmap.example');

	it('routes /api/raster?kind=atmospheric to atmospheric-tile (query wins over path)', () => {
		expect(classifyRequest(u('/api/raster?kind=atmospheric&layer=clouds-modis-terra&z=4&x=5&y=6'))).toBe(
			'atmospheric-tile',
		);
	});

	it('routes /api/raster (no kind) to raster-tile', () => {
		expect(classifyRequest(u('/api/raster?layer=viirs_2019&z=11&x=623&y=743'))).toBe('raster-tile');
	});

	it('routes /api/raster with kind != atmospheric to raster-tile', () => {
		expect(classifyRequest(u('/api/raster?kind=other&layer=viirs_2019'))).toBe('raster-tile');
	});

	it('routes /api/atmospheric/point (Open-Meteo) to atmospheric-tile', () => {
		expect(classifyRequest(u('/api/atmospheric/point?lat=40&lon=-74'))).toBe('atmospheric-tile');
	});

	it('routes /api/atmospheric/openaq (PM2.5 ground stations) to atmospheric-tile', () => {
		expect(classifyRequest(u('/api/atmospheric/openaq?bbox=-74,40,-73,41'))).toBe('atmospheric-tile');
	});

	it('routes /api/featureinfo to ephemeris', () => {
		expect(classifyRequest(u('/api/featureinfo?layer=viirs&lat=40&lon=-74'))).toBe('ephemeris');
	});

	it('routes /api/elevation to ephemeris', () => {
		expect(classifyRequest(u('/api/elevation?lat=40&lon=-74'))).toBe('ephemeris');
	});

	it('routes /projection/pulse.json to static-projection', () => {
		expect(classifyRequest(u('/projection/pulse.json'))).toBe('static-projection');
	});

	it('returns null for /api/geocode (varies too widely to cache)', () => {
		expect(classifyRequest(u('/api/geocode?q=Ithaca'))).toBeNull();
	});

	it('returns null for the app shell (handled separately by the SW)', () => {
		expect(classifyRequest(u('/'))).toBeNull();
		expect(classifyRequest(u('/docs'))).toBeNull();
	});

	it('returns null for unknown API endpoints (defensive — better to skip than mis-bucket)', () => {
		expect(classifyRequest(u('/api/somethingnew?foo=bar'))).toBeNull();
	});
});

/* ----------------------------- normalization ----------------------------- */

describe('normalizeCacheKey — stable cache keys', () => {
	const u = (s: string): URL => new URL(s, 'https://darkmap.example');

	it('collapses search-param order: ?z=4&x=3 ≡ ?x=3&z=4', () => {
		expect(normalizeCacheKey(u('/api/raster?z=4&x=3'))).toBe(normalizeCacheKey(u('/api/raster?x=3&z=4')));
	});

	it('produces a canonical sorted query string', () => {
		expect(normalizeCacheKey(u('/api/raster?z=4&layer=viirs_2019&x=3&y=2'))).toBe(
			'https://darkmap.example/api/raster?layer=viirs_2019&x=3&y=2&z=4',
		);
	});

	it('drops URL fragments before keying', () => {
		expect(normalizeCacheKey(u('/api/raster?z=4#frag'))).toBe(normalizeCacheKey(u('/api/raster?z=4')));
	});

	it('lowercases the host', () => {
		expect(normalizeCacheKey(new URL('https://Darkmap.Example/api/raster?z=4'))).toBe(
			normalizeCacheKey(u('/api/raster?z=4')),
		);
	});

	it('preserves pathname case (S3/CDN paths are case-sensitive)', () => {
		expect(normalizeCacheKey(u('/Projection/Pulse.json'))).not.toBe(normalizeCacheKey(u('/projection/pulse.json')));
	});

	it('handles repeated keys (e.g. ?tag=a&tag=b) deterministically by value', () => {
		const a = normalizeCacheKey(u('/api/raster?tag=a&tag=b'));
		const b = normalizeCacheKey(u('/api/raster?tag=b&tag=a'));
		expect(a).toBe(b);
	});

	it('produces a URL with an empty query when none provided', () => {
		expect(normalizeCacheKey(u('/projection/pulse.json'))).toBe('https://darkmap.example/projection/pulse.json');
	});

	it('preserves a trailing slash when present', () => {
		expect(normalizeCacheKey(u('/api/atmospheric/?z=4'))).toMatch(/atmospheric\/\?/);
	});
});

/* ---------------------- classify + normalize composition ---------------------- */

describe('classify + normalize compose for the SW dispatch path', () => {
	const u = (s: string): URL => new URL(s, 'https://darkmap.example');

	it('two functionally-identical atmospheric tile URLs hash to the same key + bucket', () => {
		const a = u('/api/raster?kind=atmospheric&z=4&x=5&y=6&layer=clouds-modis-terra');
		const b = u('/api/raster?layer=clouds-modis-terra&kind=atmospheric&y=6&x=5&z=4');
		expect(classifyRequest(a)).toBe('atmospheric-tile');
		expect(classifyRequest(b)).toBe('atmospheric-tile');
		expect(normalizeCacheKey(a)).toBe(normalizeCacheKey(b));
	});

	it('an atmospheric tile and a raster tile with the same z/x/y route differently', () => {
		const atm = u('/api/raster?kind=atmospheric&layer=clouds-modis-terra&z=4&x=5&y=6');
		const raster = u('/api/raster?layer=viirs_2019&z=4&x=5&y=6');
		expect(classifyRequest(atm)).toBe('atmospheric-tile');
		expect(classifyRequest(raster)).toBe('raster-tile');
		expect(normalizeCacheKey(atm)).not.toBe(normalizeCacheKey(raster));
	});
});
