import type { BasemapDef } from '$lib/basemaps';
import { BASEMAP_LAYER_ID, BASEMAP_SOURCE_ID } from './BasemapController';

/** Keep the v6 worker, raster style, and attribution control in one testable bootstrap. */
export function createMapLibreMap({
	maplibre,
	workerUrl,
	container,
	basemap,
	center,
	zoom,
}: {
	maplibre: typeof import('maplibre-gl');
	workerUrl: string;
	container: HTMLElement;
	basemap: BasemapDef;
	center: [number, number];
	zoom: number;
}): import('maplibre-gl').Map {
	// Vite's ?worker&url bundles the v6 worker's shared module. Configure the
	// emitted URL before Map creates its worker pool.
	maplibre.setWorkerUrl(workerUrl);
	const map = new maplibre.Map({
		container,
		style: {
			version: 8,
			sources: {
				[BASEMAP_SOURCE_ID]: {
					type: 'raster',
					tiles: [...basemap.tiles],
					tileSize: 256,
					attribution: basemap.attribution,
					maxzoom: basemap.maxZoom,
				},
			},
			layers: [{ id: BASEMAP_LAYER_ID, type: 'raster', source: BASEMAP_SOURCE_ID }],
		},
		center,
		zoom,
		attributionControl: false,
	});
	map.addControl(new maplibre.AttributionControl({ compact: true }), 'bottom-right');
	return map;
}
