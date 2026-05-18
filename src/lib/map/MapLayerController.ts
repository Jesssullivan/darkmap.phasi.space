/**
 * MapLayerController — Effect-mediated lifecycle for MapLibre raster
 * layers. All add/remove/setOpacity operations route through this
 * service so we get:
 *
 *  - A single place that guards `map.isStyleLoaded()` — calling
 *    `addSource` before the style finishes loading throws "Style is not
 *    done loading" inside MapLibre. The controller awaits `style.load`
 *    before touching the map.
 *  - Idempotent mount/unmount — re-mounting a live layer is a no-op,
 *    unmounting a missing one is a no-op. Callers do not have to
 *    bookkeep `getSource`/`getLayer` themselves.
 *  - Structured errors — `MapLayerError` tags failures so the toast
 *    layer can render a meaningful message instead of unwrapping a
 *    generic `Error`.
 */

import { Context, Data, Effect, Layer } from 'effect';
import type { Map as MapLibreMap } from 'maplibre-gl';

export interface RasterMount {
	readonly id: string;
	readonly tileUrlTemplate: string;
	readonly opacity: number;
	readonly tileSize?: number;
	/** When set, the new layer is inserted below this id (default: above all). */
	readonly beforeId?: string;
}

export class MapLayerError extends Data.TaggedError('MapLayerError')<{
	readonly op: 'mount' | 'unmount' | 'setOpacity' | 'awaitStyle';
	readonly id: string;
	readonly reason: string;
	readonly cause?: unknown;
}> {}

export class MapLayerController extends Context.Tag('@darkmap/MapLayerController')<
	MapLayerController,
	{
		readonly mount: (mount: RasterMount) => Effect.Effect<void, MapLayerError>;
		readonly unmount: (id: string) => Effect.Effect<void, MapLayerError>;
		readonly setOpacity: (id: string, opacity: number) => Effect.Effect<void, MapLayerError>;
	}
>() {}

const sourceIdFor = (id: string): string => `darkmap-${id}-src`;
const layerIdFor = (id: string): string => `darkmap-${id}-lyr`;

const awaitStyle = (map: MapLibreMap): Effect.Effect<void, MapLayerError> =>
	Effect.async<void, MapLayerError>((resume) => {
		if (map.isStyleLoaded()) {
			resume(Effect.void);
			return;
		}
		const onLoad = (): void => resume(Effect.void);
		map.once('style.load', onLoad);
	});

export const makeMapLayerControllerLive = (map: MapLibreMap): Layer.Layer<MapLayerController> =>
	Layer.succeed(MapLayerController, {
		mount: (m) =>
			Effect.gen(function* () {
				yield* awaitStyle(map);
				const srcId = sourceIdFor(m.id);
				const lyrId = layerIdFor(m.id);
				if (map.getLayer(lyrId) && map.getSource(srcId)) return;
				yield* Effect.try({
					try: () => {
						if (!map.getSource(srcId)) {
							map.addSource(srcId, {
								type: 'raster',
								tiles: [m.tileUrlTemplate],
								tileSize: m.tileSize ?? 256,
							});
						}
						if (!map.getLayer(lyrId)) {
							map.addLayer(
								{
									id: lyrId,
									type: 'raster',
									source: srcId,
									paint: { 'raster-opacity': m.opacity },
								},
								m.beforeId,
							);
						}
					},
					catch: (cause) => new MapLayerError({ op: 'mount', id: m.id, reason: 'addSource/addLayer failed', cause }),
				});
			}),

		unmount: (id) =>
			Effect.gen(function* () {
				yield* awaitStyle(map);
				yield* Effect.try({
					try: () => {
						const lyrId = layerIdFor(id);
						const srcId = sourceIdFor(id);
						if (map.getLayer(lyrId)) map.removeLayer(lyrId);
						if (map.getSource(srcId)) map.removeSource(srcId);
					},
					catch: (cause) => new MapLayerError({ op: 'unmount', id, reason: 'removeLayer/removeSource failed', cause }),
				});
			}),

		setOpacity: (id, opacity) =>
			Effect.gen(function* () {
				yield* awaitStyle(map);
				yield* Effect.try({
					try: () => {
						const lyrId = layerIdFor(id);
						if (map.getLayer(lyrId)) map.setPaintProperty(lyrId, 'raster-opacity', opacity);
					},
					catch: (cause) => new MapLayerError({ op: 'setOpacity', id, reason: 'setPaintProperty failed', cause }),
				});
			}),
	});

export const mapLayerControllerIds = { sourceIdFor, layerIdFor };
