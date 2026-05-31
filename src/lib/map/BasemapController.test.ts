import { afterEach, describe, expect, it } from 'vitest';
import {
	applyBasemap,
	applyBasemapTimed,
	BASEMAP_LAYER_ID,
	BASEMAP_SOURCE_ID,
	firstOverlayLayerId,
	type BasemapSpec,
} from './BasemapController';
import { mapLayerControllerIds, type MapLibreSurface } from './MapLayerController';

class FakeMap implements MapLibreSurface {
	private sources = new Set<string>();
	/** Ordered list of layer ids — the front of the array is the bottom of the stack. */
	private layerOrder: string[] = [];
	public calls: string[] = [];

	isStyleLoaded(): boolean {
		return true;
	}
	once(): void {}
	getSource(id: string): unknown {
		return this.sources.has(id) ? { id } : undefined;
	}
	getLayer(id: string): unknown {
		return this.layerOrder.includes(id) ? { id } : undefined;
	}
	addSource(id: string, _spec?: Record<string, unknown>): void {
		void _spec;
		this.sources.add(id);
		this.calls.push(`addSource:${id}`);
	}
	addLayer(spec: Record<string, unknown>, beforeId?: string): void {
		const id = spec.id as string;
		if (beforeId !== undefined) {
			const idx = this.layerOrder.indexOf(beforeId);
			if (idx >= 0) {
				this.layerOrder.splice(idx, 0, id);
				this.calls.push(`addLayer:${id} before:${beforeId}`);
				return;
			}
		}
		this.layerOrder.push(id);
		this.calls.push(`addLayer:${id}`);
	}
	removeSource(id: string): void {
		this.sources.delete(id);
		this.calls.push(`removeSource:${id}`);
	}
	removeLayer(id: string): void {
		this.layerOrder = this.layerOrder.filter((x) => x !== id);
		this.calls.push(`removeLayer:${id}`);
	}
	setPaintProperty(): void {}

	/** Test helper — seed a layer at the top of the stack. */
	preloadLayer(id: string): void {
		this.layerOrder.push(id);
	}

	get order(): readonly string[] {
		return [...this.layerOrder];
	}
}

const darkSpec: BasemapSpec = {
	tiles: ['https://example/dark/{z}/{x}/{y}.png'],
	attribution: '© Dark',
};
const osmSpec: BasemapSpec = {
	tiles: ['https://example/osm/{z}/{x}/{y}.png'],
	attribution: '© OSM',
	maxZoom: 19,
};

let map: FakeMap;
afterEach(() => {
	map = new FakeMap();
});

describe('firstOverlayLayerId', () => {
	it('returns undefined when no overlays are active', () => {
		map = new FakeMap();
		expect(firstOverlayLayerId(map)).toBeUndefined();
	});

	it('returns the lowest-LAYERS-index overlay that is currently mounted', () => {
		map = new FakeMap();
		// LAYERS order: viirs (multiple years), world_atlas, atmospheric...
		// Seed an atmospheric layer + a world atlas layer.
		const wa = mapLayerControllerIds.layerIdFor('world_atlas_2015');
		const atm = mapLayerControllerIds.layerIdFor('clouds-modis-terra');
		map.preloadLayer(atm);
		map.preloadLayer(wa);
		// LAYERS index puts world_atlas before atmospheric, so wa wins.
		expect(firstOverlayLayerId(map)).toBe(wa);
	});
});

describe('applyBasemap — happy path', () => {
	it('adds the basemap source + layer when none exists', () => {
		map = new FakeMap();
		applyBasemap(map, darkSpec);
		expect(map.getSource(BASEMAP_SOURCE_ID)).toBeDefined();
		expect(map.getLayer(BASEMAP_LAYER_ID)).toBeDefined();
	});

	it('removes the prior basemap before re-adding (idempotent swap)', () => {
		map = new FakeMap();
		applyBasemap(map, darkSpec);
		map.calls.length = 0;
		applyBasemap(map, osmSpec);
		// Each swap removes both layer + source then re-adds.
		expect(map.calls).toEqual([
			`removeLayer:${BASEMAP_LAYER_ID}`,
			`removeSource:${BASEMAP_SOURCE_ID}`,
			`addSource:${BASEMAP_SOURCE_ID}`,
			`addLayer:${BASEMAP_LAYER_ID}`,
		]);
	});
});

describe('applyBasemap — overlay ordering invariants (#198)', () => {
	it('inserts the basemap below the first active overlay', () => {
		map = new FakeMap();
		const wa = mapLayerControllerIds.layerIdFor('world_atlas_2015');
		map.preloadLayer(wa);
		applyBasemap(map, darkSpec);
		// Basemap must be below the world atlas layer.
		const idx = map.order.indexOf(BASEMAP_LAYER_ID);
		const waIdx = map.order.indexOf(wa);
		expect(idx).toBeLessThan(waIdx);
	});

	it('survives repeated swaps with overlays present', () => {
		map = new FakeMap();
		const viirs = mapLayerControllerIds.layerIdFor('viirs_2019');
		const atm = mapLayerControllerIds.layerIdFor('clouds-modis-terra');
		map.preloadLayer(viirs);
		map.preloadLayer(atm);

		applyBasemap(map, darkSpec);
		applyBasemap(map, osmSpec);
		applyBasemap(map, darkSpec);

		// Each overlay still present, basemap still below the lowest.
		expect(map.order).toContain(viirs);
		expect(map.order).toContain(atm);
		expect(map.order.indexOf(BASEMAP_LAYER_ID)).toBeLessThan(map.order.indexOf(viirs));
	});

	it('never touches overlay sources during a swap', () => {
		map = new FakeMap();
		map.addSource(`darkmap-viirs_2019-src`); // pre-existing overlay source
		map.calls.length = 0;
		applyBasemap(map, darkSpec);
		// Only basemap sources should appear in the call log.
		const overlaySourceCalls = map.calls.filter((c) => c.includes('Source:') && !c.includes(BASEMAP_SOURCE_ID));
		expect(overlaySourceCalls).toEqual([]);
	});

	it('still works when no overlays are active (basemap goes on top)', () => {
		map = new FakeMap();
		applyBasemap(map, darkSpec);
		expect(map.order).toContain(BASEMAP_LAYER_ID);
	});
});

describe('applyBasemap — spec fields', () => {
	it('passes attribution + maxzoom through to addSource', () => {
		map = new FakeMap();
		let spec: Record<string, unknown> | undefined;
		const originalAdd = map.addSource.bind(map);
		map.addSource = (id, s) => {
			if (id === BASEMAP_SOURCE_ID) spec = s as Record<string, unknown>;
			originalAdd(id, s ?? {});
		};
		applyBasemap(map, osmSpec);
		expect(spec?.attribution).toBe('© OSM');
		expect(spec?.maxzoom).toBe(19);
	});
});

describe('applyBasemapTimed', () => {
	it('returns a non-negative elapsed ms reading', () => {
		map = new FakeMap();
		const ms = applyBasemapTimed(map, darkSpec);
		expect(ms).toBeGreaterThanOrEqual(0);
	});

	it('error from MapLibre still propagates', () => {
		map = new FakeMap();
		const broken = {
			...map,
			isStyleLoaded: () => true,
			once: () => {},
			getSource: () => undefined,
			getLayer: () => undefined,
			addSource: () => {
				throw new Error('addSource broke');
			},
			addLayer: () => {},
			removeSource: () => {},
			removeLayer: () => {},
			setPaintProperty: () => {},
		} as MapLibreSurface;
		expect(() => applyBasemapTimed(broken, darkSpec)).toThrow(/addSource broke/);
	});
});
