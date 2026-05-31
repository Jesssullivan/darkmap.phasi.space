/**
 * BasemapController — extracts the basemap swap logic that used to sit
 * inline in `+page.svelte` (#198). Pure helper, no Effect surface needed
 * because the operations are synchronous and have no interesting error
 * shape beyond MapLibre throws (which the page handles via the global
 * `error` listener).
 *
 * The contract this helper enforces:
 *
 *   1. **Preserve overlay ordering**: every overlay layer that already
 *      sits above the basemap stays above it. We achieve this by
 *      inserting the new basemap layer with `beforeId = firstOverlay`,
 *      so MapLibre slots it underneath the lowest overlay.
 *   2. **Do not touch overlay sources**: the swap removes and re-adds
 *      only `darkmap-basemap-src` / `darkmap-basemap-lyr`. Overlay
 *      sources keep their tiles and avoid a refetch flicker.
 *   3. **Time the swap**: callers can wrap a `performance.now()` pair
 *      around `applyBasemap` to record switch latency. We don't bake
 *      observability into the controller itself — that's a routing
 *      decision (toast, analytics, console) the page should make.
 *
 * The function takes a `MapLibreSurface` so the test suite can run
 * against a fake without MapLibre. The real `Map` type satisfies it.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { LAYERS } from '$lib/layers';
import type { MapLibreSurface } from './MapLayerController';
import { mapLayerControllerIds } from './MapLayerController';

export const BASEMAP_SOURCE_ID = 'darkmap-basemap-src';
export const BASEMAP_LAYER_ID = 'darkmap-basemap-lyr';

export interface BasemapSpec {
	readonly tiles: ReadonlyArray<string>;
	readonly attribution: string;
	readonly maxZoom?: number;
	readonly tileSize?: number;
}

/**
 * Find the lowest active overlay layer id, so the basemap can be inserted
 * underneath it. Returns `undefined` if no overlays are active (basemap
 * becomes the top layer).
 *
 * Exported so the test suite can sweep ordering invariants without faking
 * a full Map.
 */
export const firstOverlayLayerId = (map: MapLibreSurface): string | undefined => {
	for (const def of LAYERS) {
		const lyrId = mapLayerControllerIds.layerIdFor(def.id);
		if (map.getLayer(lyrId)) return lyrId;
	}
	return undefined;
};

/**
 * Swap the basemap source + layer while preserving the overlay stack.
 * Idempotent in the sense that calling with the same `id` re-adds the
 * same source/layer (callers typically gate on `activeBasemap` change).
 */
export const applyBasemap = (mapLike: MapLibreSurface | MapLibreMap, spec: BasemapSpec): void => {
	const map = mapLike as MapLibreSurface;
	if (map.getLayer(BASEMAP_LAYER_ID)) map.removeLayer(BASEMAP_LAYER_ID);
	if (map.getSource(BASEMAP_SOURCE_ID)) map.removeSource(BASEMAP_SOURCE_ID);
	map.addSource(BASEMAP_SOURCE_ID, {
		type: 'raster',
		tiles: [...spec.tiles],
		tileSize: spec.tileSize ?? 256,
		attribution: spec.attribution,
		...(spec.maxZoom !== undefined ? { maxzoom: spec.maxZoom } : {}),
	});
	map.addLayer({ id: BASEMAP_LAYER_ID, type: 'raster', source: BASEMAP_SOURCE_ID }, firstOverlayLayerId(map));
};

/**
 * Wrap `applyBasemap` with a high-resolution timing pair. Returns the
 * elapsed wall-clock duration in milliseconds so callers can compare
 * against a perf budget. Errors thrown by MapLibre still propagate.
 */
export const applyBasemapTimed = (mapLike: MapLibreSurface | MapLibreMap, spec: BasemapSpec): number => {
	const start = performance.now();
	applyBasemap(mapLike, spec);
	return performance.now() - start;
};
