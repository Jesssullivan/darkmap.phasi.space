/**
 * Layer manifest. Each entry maps a friendly id (`viirs_2019`) to an
 * upstream GeoServer WMS layer name (`PostGIS:VIIRS_2019`). The browser
 * fetches `/api/raster?layer=<id>&z=...&x=...&y=...`; the server-side
 * RasterClient does the upstream-layer lookup before calling GetMap.
 *
 * Live GeoServer discovery 2026-05-17 (see TIN-1289). `viirs_2020` and
 * `viirs_2021` annual composites do **not** exist upstream — the latest
 * annual is 2019. Monthly composites live under `lighttrends:` if we
 * want a "trend" overlay later.
 */

export type LayerKind = 'viirs_year' | 'world_atlas';

export interface RasterLayerDef {
	readonly id: string;
	readonly upstreamLayer: string;
	readonly label: string;
	readonly description: string;
	readonly kind: LayerKind;
	readonly defaultEnabled: boolean;
	/** 0..1 opacity in the MapLibre raster source. */
	readonly opacity: number;
}

export const LAYERS: ReadonlyArray<RasterLayerDef> = [
	{
		id: 'viirs_2019',
		upstreamLayer: 'PostGIS:VIIRS_2019',
		label: 'VIIRS 2019',
		description: 'NOAA VIIRS DNB annual composite, 2019 (latest annual available).',
		kind: 'viirs_year',
		defaultEnabled: true,
		opacity: 0.85,
	},
	{
		id: 'viirs_2018',
		upstreamLayer: 'PostGIS:VIIRS_2018',
		label: 'VIIRS 2018',
		description: 'NOAA VIIRS DNB annual composite, 2018.',
		kind: 'viirs_year',
		defaultEnabled: false,
		opacity: 0.85,
	},
	{
		id: 'viirs_2017',
		upstreamLayer: 'PostGIS:VIIRS_2017',
		label: 'VIIRS 2017',
		description: 'NOAA VIIRS DNB annual composite, 2017.',
		kind: 'viirs_year',
		defaultEnabled: false,
		opacity: 0.85,
	},
	{
		id: 'viirs_2014',
		upstreamLayer: 'PostGIS:VIIRS_2014',
		label: 'VIIRS 2014',
		description: 'NOAA VIIRS DNB annual composite, 2014 (early baseline).',
		kind: 'viirs_year',
		defaultEnabled: false,
		opacity: 0.85,
	},
	{
		id: 'world_atlas_2015',
		upstreamLayer: 'PostGIS:WA_2015',
		label: 'World Atlas 2015',
		description: 'Falchi et al. 2016 World Atlas of Artificial Night Sky Brightness.',
		kind: 'world_atlas',
		defaultEnabled: false,
		opacity: 0.7,
	},
];

/** MapLibre raster source URL template targeting our proxy. */
export const rasterUrlTemplate = (layerId: string): string =>
	`/api/raster?layer=${encodeURIComponent(layerId)}&z={z}&x={x}&y={y}`;

/** Default map center — Ithaca, NY (the lab fallback when geolocation is unavailable). */
export const FALLBACK_CENTER: readonly [number, number] = [-76.5019, 42.4434];
export const FALLBACK_ZOOM = 9;
