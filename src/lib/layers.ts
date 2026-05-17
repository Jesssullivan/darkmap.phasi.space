/**
 * Layer manifest for the upstream QueryRaster overlays. Each entry maps
 * to an `ql=<id>` parameter on `/api/raster`. The `qt`/`qd` encoding
 * passed through to the upstream is `qt=tile&qd={z}/{x}/{y}` for now —
 * once we observe real upstream tile semantics during the TIN-1278
 * smoke, the encoding may be refined per-layer.
 */

export type LayerKind = 'viirs_year' | 'viirs_trend' | 'world_atlas' | 'sqm_user';

export interface RasterLayerDef {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly kind: LayerKind;
	readonly defaultEnabled: boolean;
	/** 0..1 opacity in the MapLibre raster source. */
	readonly opacity: number;
}

export const LAYERS: ReadonlyArray<RasterLayerDef> = [
	{
		id: 'viirs_2021',
		label: 'VIIRS 2021',
		description: 'NOAA VIIRS DNB annual composite, 2021.',
		kind: 'viirs_year',
		defaultEnabled: true,
		opacity: 0.85,
	},
	{
		id: 'viirs_2020',
		label: 'VIIRS 2020',
		description: 'NOAA VIIRS DNB annual composite, 2020.',
		kind: 'viirs_year',
		defaultEnabled: false,
		opacity: 0.85,
	},
	{
		id: 'viirs_2017',
		label: 'VIIRS 2017',
		description: 'NOAA VIIRS DNB annual composite, 2017.',
		kind: 'viirs_year',
		defaultEnabled: false,
		opacity: 0.85,
	},
	{
		id: 'viirs_trend',
		label: 'VIIRS Trend',
		description: 'Multi-year VIIRS DNB trend (radiance change over time).',
		kind: 'viirs_trend',
		defaultEnabled: false,
		opacity: 0.75,
	},
	{
		id: 'world_atlas_2015',
		label: 'World Atlas 2015',
		description: 'Falchi et al. 2016 World Atlas of Artificial Night Sky Brightness.',
		kind: 'world_atlas',
		defaultEnabled: false,
		opacity: 0.7,
	},
	{
		id: 'sqm_user',
		label: 'SQM (user-contributed)',
		description: 'User-contributed SQM / SQM-L sky quality meter overlay (read-only).',
		kind: 'sqm_user',
		defaultEnabled: false,
		opacity: 0.6,
	},
];

/** MapLibre raster source URL template targeting our proxy. */
export const rasterUrlTemplate = (layerId: string): string =>
	`/api/raster?layer=${encodeURIComponent(layerId)}&qt=tile&qd={z}/{x}/{y}`;

/** Default map center — Ithaca, NY (the lab fallback when geolocation is unavailable). */
export const FALLBACK_CENTER: readonly [number, number] = [-76.5019, 42.4434];
export const FALLBACK_ZOOM = 9;
