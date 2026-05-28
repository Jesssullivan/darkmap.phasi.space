/**
 * MapLayerController — Effect-mediated lifecycle for MapLibre raster
 * layers. All add/remove/setOpacity operations route through this
 * service so we get:
 *
 *  - A single place that guards `map.isStyleLoaded()` — calling
 *    `addSource` before the style finishes loading throws "Style is not
 *    done loading" inside MapLibre. The controller awaits `style.load`
 *    before touching the map.
 *  - Generation-token cancellation (#194). Each mount/unmount bumps a
 *    per-layer token; operations re-check the token after every await
 *    and bail without side effects if the user has since toggled the
 *    layer off (or re-mounted with a different config). Eliminates the
 *    race where a slow `style.load` resolves after an unmount and adds
 *    a stale source.
 *  - Explicit per-id lifecycle state (`idle` / `loading` / `mounted` /
 *    `removing` / `error`) for callers that want to inspect status
 *    without touching MapLibre internals.
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
	/** Highest native source zoom. MapLibre overzooms instead of requesting above it. */
	readonly maxZoom?: number;
	/** When set, the new layer is inserted below this id (default: above all). */
	readonly beforeId?: string;
	/** Source attribution surfaced in MapLibre's attribution control. */
	readonly attribution?: string;
}

export type LayerLifecycleTag = 'idle' | 'loading' | 'mounted' | 'removing' | 'error';

export interface LayerLifecycleState {
	readonly tag: LayerLifecycleTag;
	readonly generation: number;
	readonly reason?: string;
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
		/**
		 * Snapshot the current lifecycle state for a given layer id. Returns
		 * `idle` for ids the controller has no record of.
		 */
		readonly stateOf: (id: string) => LayerLifecycleState;
	}
>() {}

const sourceIdFor = (id: string): string => `darkmap-${id}-src`;
const layerIdFor = (id: string): string => `darkmap-${id}-lyr`;

/**
 * Minimal MapLibre Map surface the controller actually touches. Lets the
 * test suite swap in a fake without dragging in the full MapLibre lib-dom
 * types. The real `MapLibreMap` type satisfies this interface.
 */
export interface MapLibreSurface {
	isStyleLoaded(): boolean;
	once(event: string, cb: () => void): unknown;
	getSource(id: string): unknown;
	getLayer(id: string): unknown;
	addSource(id: string, spec: Record<string, unknown>): unknown;
	addLayer(spec: Record<string, unknown>, beforeId?: string): unknown;
	removeSource(id: string): unknown;
	removeLayer(id: string): unknown;
	setPaintProperty(layerId: string, prop: string, value: unknown): unknown;
}

const awaitStyle = (map: MapLibreSurface): Effect.Effect<void, MapLayerError> =>
	Effect.async<void, MapLayerError>((resume) => {
		if (map.isStyleLoaded()) {
			resume(Effect.void);
			return;
		}
		const onLoad = (): void => resume(Effect.void);
		map.once('style.load', onLoad);
	});

export const makeMapLayerControllerLive = (mapLike: MapLibreSurface | MapLibreMap): Layer.Layer<MapLayerController> => {
	const map = mapLike as MapLibreSurface;

	// Per-layer generation token + lifecycle state. The token increments on
	// every mount/unmount; long-running effects re-check it after awaits and
	// bail on mismatch (#194).
	const generations = new Map<string, number>();
	const states = new Map<string, LayerLifecycleState>();

	const bumpGeneration = (id: string): number => {
		const next = (generations.get(id) ?? 0) + 1;
		generations.set(id, next);
		return next;
	};
	const currentGeneration = (id: string): number => generations.get(id) ?? 0;
	const setState = (id: string, state: LayerLifecycleState): void => {
		states.set(id, state);
	};
	const stateOf = (id: string): LayerLifecycleState =>
		states.get(id) ?? { tag: 'idle', generation: currentGeneration(id) };

	return Layer.succeed(MapLayerController, {
		mount: (m) =>
			Effect.gen(function* () {
				const gen = bumpGeneration(m.id);
				setState(m.id, { tag: 'loading', generation: gen });

				yield* awaitStyle(map);
				// A more recent mount/unmount may have superseded us. Drop out
				// without touching the map — the newer op owns the layer.
				if (currentGeneration(m.id) !== gen) return;

				const srcId = sourceIdFor(m.id);
				const lyrId = layerIdFor(m.id);
				if (map.getLayer(lyrId) && map.getSource(srcId)) {
					setState(m.id, { tag: 'mounted', generation: gen });
					return;
				}

				yield* Effect.try({
					try: () => {
						if (currentGeneration(m.id) !== gen) return;
						if (!map.getSource(srcId)) {
							map.addSource(srcId, {
								type: 'raster',
								tiles: [m.tileUrlTemplate],
								tileSize: m.tileSize ?? 256,
								...(m.maxZoom !== undefined ? { maxzoom: m.maxZoom } : {}),
								...(m.attribution ? { attribution: m.attribution } : {}),
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
						setState(m.id, { tag: 'mounted', generation: gen });
					},
					catch: (cause) => {
						setState(m.id, { tag: 'error', generation: gen, reason: 'addSource/addLayer failed' });
						return new MapLayerError({ op: 'mount', id: m.id, reason: 'addSource/addLayer failed', cause });
					},
				});
			}),

		unmount: (id) =>
			Effect.gen(function* () {
				const gen = bumpGeneration(id);
				setState(id, { tag: 'removing', generation: gen });

				yield* awaitStyle(map);
				if (currentGeneration(id) !== gen) return;

				yield* Effect.try({
					try: () => {
						if (currentGeneration(id) !== gen) return;
						const lyrId = layerIdFor(id);
						const srcId = sourceIdFor(id);
						if (map.getLayer(lyrId)) map.removeLayer(lyrId);
						if (map.getSource(srcId)) map.removeSource(srcId);
						setState(id, { tag: 'idle', generation: gen });
					},
					catch: (cause) => {
						setState(id, { tag: 'error', generation: gen, reason: 'removeLayer/removeSource failed' });
						return new MapLayerError({
							op: 'unmount',
							id,
							reason: 'removeLayer/removeSource failed',
							cause,
						});
					},
				});
			}),

		setOpacity: (id, opacity) =>
			Effect.gen(function* () {
				yield* awaitStyle(map);
				yield* Effect.try({
					try: () => {
						const lyrId = layerIdFor(id);
						// Apply only to a live layer — if the user has unmounted in the
						// meantime, swallow rather than throwing.
						if (map.getLayer(lyrId)) map.setPaintProperty(lyrId, 'raster-opacity', opacity);
					},
					catch: (cause) => new MapLayerError({ op: 'setOpacity', id, reason: 'setPaintProperty failed', cause }),
				});
			}),

		stateOf,
	});
};

export const mapLayerControllerIds = { sourceIdFor, layerIdFor };
