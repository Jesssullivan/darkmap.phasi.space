import { describe, expect, it } from 'vitest';
import { parseLayerIdFromSourceId } from './source-id';

/**
 * Contract test for the `darkmap-{layerId}-src` parsing pattern. The
 * helper is consumed by +page.svelte's MapLibre `error` / `sourcedata`
 * handlers to dispatch health updates (#196). This file pins the
 * contract so changes to the source-id scheme have to update health
 * wiring deliberately.
 */

describe('source-id → layerId parsing (#196)', () => {
	it('parses VIIRS annual source ids', () => {
		expect(parseLayerIdFromSourceId('darkmap-viirs_2019-src')).toBe('viirs_2019');
		expect(parseLayerIdFromSourceId('darkmap-viirs_2012-src')).toBe('viirs_2012');
	});

	it('parses World Atlas source ids', () => {
		expect(parseLayerIdFromSourceId('darkmap-world_atlas_2015-src')).toBe('world_atlas_2015');
		expect(parseLayerIdFromSourceId('darkmap-world_atlas_2015_raw-src')).toBe('world_atlas_2015_raw');
	});

	it('parses atmospheric raster source ids', () => {
		expect(parseLayerIdFromSourceId('darkmap-clouds-modis-terra-src')).toBe('clouds-modis-terra');
		expect(parseLayerIdFromSourceId('darkmap-aerosol-modis-aod-src')).toBe('aerosol-modis-aod');
		expect(parseLayerIdFromSourceId('darkmap-water-vapor-airs-src')).toBe('water-vapor-airs');
	});

	it('returns the basemap synthetic id (no LAYERS entry; ignored by LayerRail)', () => {
		expect(parseLayerIdFromSourceId('darkmap-basemap-src')).toBe('basemap');
	});

	it('rejects ids missing the prefix or suffix (no false positives on third-party sources)', () => {
		expect(parseLayerIdFromSourceId('other-thing-src')).toBeNull();
		expect(parseLayerIdFromSourceId('darkmap-thing-foo')).toBeNull();
		expect(parseLayerIdFromSourceId(undefined)).toBeNull();
		expect(parseLayerIdFromSourceId('')).toBeNull();
	});

	it('skips point-source overlays (they use a -pt-src suffix; health is dispatched directly)', () => {
		// OpenAQ PM2.5 source ids end in `-pt-src`, not `-src`, so the
		// generic raster-event wiring skips them and the page's
		// refreshPointLayer dispatches health explicitly.
		expect(parseLayerIdFromSourceId('darkmap-smog-openaq-pm25-pt-src')).toBeNull();
	});
});
