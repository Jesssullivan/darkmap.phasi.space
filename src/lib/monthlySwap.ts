/**
 * Monthly raster layer swap helper (TIN-1301 sub 4).
 *
 * Switching the active VIIRS monthly composite means swapping the
 * MapLibre source + layer pair. Doing this naively (remove old, then
 * add new) flashes the basemap through for the few hundred ms while
 * the new source's tiles load. The "anti-flash" pattern:
 *
 *   1. Add the new source + layer at target opacity *above* the old.
 *   2. Wait for MapLibre to report `idle` (all sources settled).
 *   3. Remove the old layer + source.
 *
 * Because the new layer paints over the old while loading, the user
 * never sees the gap.
 *
 * The helper is pure modulo the `MonthlyMapAdapter` boundary — that's
 * the minimal subset of maplibre-gl's `Map` we touch, which lets us
 * unit-test against a recording mock without spinning up WebGL.
 */

export interface MonthlyMapAdapter {
	getSource: (id: string) => boolean;
	getLayer: (id: string) => boolean;
	addSource: (id: string, opts: { type: 'raster'; tiles: readonly string[]; tileSize: number }) => void;
	removeSource: (id: string) => void;
	addLayer: (
		spec: { id: string; type: 'raster'; source: string; paint: { 'raster-opacity': number } },
		beforeId?: string,
	) => void;
	removeLayer: (id: string) => void;
	setPaintProperty: (id: string, prop: string, value: unknown) => void;
	once: (event: 'idle', handler: () => void) => void;
}

export const monthlySourceId = (layerId: string): string => `darkmap-monthly-${layerId}-src`;
export const monthlyLayerId = (layerId: string): string => `darkmap-monthly-${layerId}-lyr`;

export interface SwapParams {
	readonly oldLayerId: string | null;
	readonly newLayerId: string;
	readonly opacity: number;
	readonly tileUrlTemplate: (layerId: string) => string;
}

export const swapMonthlyLayer = async (adapter: MonthlyMapAdapter, params: SwapParams): Promise<void> => {
	const newSrcId = monthlySourceId(params.newLayerId);
	const newLyrId = monthlyLayerId(params.newLayerId);

	if (!adapter.getSource(newSrcId)) {
		adapter.addSource(newSrcId, {
			type: 'raster',
			tiles: [params.tileUrlTemplate(params.newLayerId)],
			tileSize: 256,
		});
	}
	if (!adapter.getLayer(newLyrId)) {
		adapter.addLayer({
			id: newLyrId,
			type: 'raster',
			source: newSrcId,
			paint: { 'raster-opacity': params.opacity },
		});
	} else {
		// Same layer already mounted — just push the opacity. Caller may
		// be re-rendering after a viewport change.
		adapter.setPaintProperty(newLyrId, 'raster-opacity', params.opacity);
	}

	if (!params.oldLayerId || params.oldLayerId === params.newLayerId) return;

	// Wait for the next map idle tick so new tiles paint over the old
	// before we remove the old source. Prevents a basemap flash.
	await new Promise<void>((resolve) => adapter.once('idle', () => resolve()));

	const oldLyrId = monthlyLayerId(params.oldLayerId);
	const oldSrcId = monthlySourceId(params.oldLayerId);
	if (adapter.getLayer(oldLyrId)) adapter.removeLayer(oldLyrId);
	if (adapter.getSource(oldSrcId)) adapter.removeSource(oldSrcId);
};

/**
 * Remove every mounted monthly source + layer. Used when the user
 * disables monthly mode entirely.
 */
export const teardownMonthlyLayer = (adapter: MonthlyMapAdapter, currentLayerId: string | null): void => {
	if (!currentLayerId) return;
	const lyrId = monthlyLayerId(currentLayerId);
	const srcId = monthlySourceId(currentLayerId);
	if (adapter.getLayer(lyrId)) adapter.removeLayer(lyrId);
	if (adapter.getSource(srcId)) adapter.removeSource(srcId);
};
