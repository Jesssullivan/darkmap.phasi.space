/**
 * Maps a MapLibre source id (e.g. `darkmap-clouds-modis-terra-src`) back
 * to its `LAYERS.id` string for health-state dispatch (#196).
 *
 * Returns `null` for any id we shouldn't dispatch health for:
 *   - Missing the `darkmap-` prefix (a third-party source)
 *   - Missing the `-src` suffix (not a source id)
 *   - Ends with `-pt-src` (point-source overlay; health is dispatched
 *     explicitly by `refreshPointLayer`, not by the generic raster
 *     `sourcedata` / `error` event handlers — including these would
 *     create orphan registry entries the LayerRail never reads)
 */
export const parseLayerIdFromSourceId = (sourceId: string | undefined | null): string | null => {
	if (!sourceId) return null;
	if (!sourceId.startsWith('darkmap-')) return null;
	if (!sourceId.endsWith('-src')) return null;
	const stripped = sourceId.slice('darkmap-'.length, -'-src'.length);
	if (stripped.endsWith('-pt')) return null;
	return stripped;
};
