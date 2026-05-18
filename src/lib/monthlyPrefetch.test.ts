import { describe, expect, it, vi } from 'vitest';
import { prefetchMonthlyTiles, prefetchTileUrls, tilesForViewport, type BoundsAndZoom } from './monthlyPrefetch';

const TEMPLATE = (id: string) => `/api/raster?layer=${id}&z={z}&x={x}&y={y}`;

describe('tilesForViewport', () => {
	it('returns a single tile at z=0 covering the whole world', () => {
		const tiles = tilesForViewport({ north: 85, south: -85, east: 180, west: -180, zoom: 0 });
		expect(tiles).toEqual([{ z: 0, x: 0, y: 0 }]);
	});

	it('returns a 2x2 grid at z=1 spanning the world', () => {
		const tiles = tilesForViewport({ north: 80, south: -80, east: 179, west: -179, zoom: 1 });
		expect(tiles).toHaveLength(4);
		const ids = new Set(tiles.map((t) => `${t.x},${t.y}`));
		expect(ids).toEqual(new Set(['0,0', '1,0', '0,1', '1,1']));
	});

	it('returns a single tile for a small region in the middle of one', () => {
		// A tight box inside one z=4 tile.
		const tiles = tilesForViewport({
			north: 40.8,
			south: 40.7,
			east: -73.9,
			west: -74.05,
			zoom: 4,
		});
		expect(tiles).toHaveLength(1);
		expect(tiles[0].z).toBe(4);
	});

	it('handles antimeridian crossings by splitting the X range', () => {
		// Viewport from lon 170 (west) wrapping past 180 to -170 (east).
		const tiles = tilesForViewport({
			north: 10,
			south: -10,
			east: -170,
			west: 170,
			zoom: 2,
		});
		// At z=2, x runs 0..3 (4 cols). lon 170 → x ~3, lon -170 → x ~0.
		// Result should include both edges of the world.
		const xs = new Set(tiles.map((t) => t.x));
		expect(xs.has(0)).toBe(true);
		expect(xs.has(3)).toBe(true);
	});

	it('floors fractional zoom values', () => {
		const tiles = tilesForViewport({ north: 0.1, south: -0.1, east: 0.1, west: -0.1, zoom: 4.7 });
		expect(tiles.every((t) => t.z === 4)).toBe(true);
	});
});

describe('prefetchTileUrls', () => {
	it('spawns an Image() per URL with crossOrigin anonymous and src set', () => {
		const created: HTMLImageElement[] = [];
		const factory = () => {
			const img = {
				crossOrigin: '',
				src: '',
			} as unknown as HTMLImageElement;
			created.push(img);
			return img;
		};
		prefetchTileUrls(['/a.png', '/b.png', '/c.png'], factory);
		expect(created).toHaveLength(3);
		expect(created[0].crossOrigin).toBe('anonymous');
		expect(created.map((i) => i.src)).toEqual(['/a.png', '/b.png', '/c.png']);
	});

	it('is a no-op for an empty url list', () => {
		const factory = vi.fn(() => ({ crossOrigin: '', src: '' }) as unknown as HTMLImageElement);
		prefetchTileUrls([], factory);
		expect(factory).not.toHaveBeenCalled();
	});
});

describe('prefetchMonthlyTiles', () => {
	const mkBounds = (overrides: Partial<BoundsAndZoom> = {}): BoundsAndZoom => ({
		north: 1,
		south: -1,
		east: 1,
		west: -1,
		zoom: 4,
		...overrides,
	});

	it('builds URLs by substituting {z}/{x}/{y} into the template', () => {
		const captured: string[] = [];
		const factory = () => {
			const img = { crossOrigin: '', src: '' } as unknown as HTMLImageElement;
			Object.defineProperty(img, 'src', {
				set(v: string) {
					captured.push(v);
				},
				get() {
					return '';
				},
			});
			return img;
		};
		const count = prefetchMonthlyTiles('viirs_2020_07', TEMPLATE, mkBounds(), factory);
		expect(count).toBeGreaterThan(0);
		expect(captured).toHaveLength(count);
		expect(captured[0]).toMatch(/^\/api\/raster\?layer=viirs_2020_07&z=4&x=\d+&y=\d+$/);
	});

	it('returns the number of tiles enqueued', () => {
		// Whole world at z=1 = 4 tiles.
		const count = prefetchMonthlyTiles(
			'viirs_2020_07',
			TEMPLATE,
			mkBounds({ north: 80, south: -80, east: 179, west: -179, zoom: 1 }),
			() => ({ crossOrigin: '', src: '' }) as unknown as HTMLImageElement,
		);
		expect(count).toBe(4);
	});
});
