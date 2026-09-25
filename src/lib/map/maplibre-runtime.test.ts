import { describe, expect, it } from 'vitest';
import { BASEMAP_LAYER_ID, BASEMAP_SOURCE_ID } from './BasemapController';
import { createMapLibreMap } from './maplibre-runtime';

describe('MapLibre v6 bootstrap', () => {
	it('configures the bundled worker before creating a raster map with explicit attribution', () => {
		const calls: string[] = [];
		let mapOptions: Record<string, unknown> | undefined;
		let attributionOptions: Record<string, unknown> | undefined;
		class FakeMap {
			constructor(options: Record<string, unknown>) {
				calls.push('map');
				mapOptions = options;
			}
			addControl(control: FakeAttributionControl, position: string): this {
				calls.push(`control:${position}`);
				expect(control).toBeInstanceOf(FakeAttributionControl);
				return this;
			}
		}
		class FakeAttributionControl {
			constructor(options: Record<string, unknown>) {
				attributionOptions = options;
			}
		}
		const maplibre = {
			setWorkerUrl: (url: string) => calls.push(`worker:${url}`),
			Map: FakeMap,
			AttributionControl: FakeAttributionControl,
		} as unknown as typeof import('maplibre-gl');
		const container = {} as HTMLElement;
		const map = createMapLibreMap({
			maplibre,
			workerUrl: '/_app/immutable/workers/maplibre-gl-worker-abc.js',
			container,
			basemap: {
				id: 'osm',
				label: 'OSM',
				description: 'OpenStreetMap',
				tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png'],
				attribution: '© OpenStreetMap',
				maxZoom: 19,
			},
			center: [-76.501, 42.443],
			zoom: 8,
		});

		expect(map).toBeInstanceOf(FakeMap);
		expect(calls).toEqual(['worker:/_app/immutable/workers/maplibre-gl-worker-abc.js', 'map', 'control:bottom-right']);
		expect(mapOptions).toMatchObject({
			container,
			center: [-76.501, 42.443],
			zoom: 8,
			attributionControl: false,
			style: {
				version: 8,
				sources: {
					[BASEMAP_SOURCE_ID]: {
						type: 'raster',
						tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png'],
						tileSize: 256,
						attribution: '© OpenStreetMap',
						maxzoom: 19,
					},
				},
				layers: [{ id: BASEMAP_LAYER_ID, type: 'raster', source: BASEMAP_SOURCE_ID }],
			},
		});
		expect(attributionOptions).toEqual({ compact: true });
	});
});
