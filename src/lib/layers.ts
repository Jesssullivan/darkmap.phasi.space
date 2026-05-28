/**
 * Layer manifest. Each entry maps a friendly id (`viirs_2019`) to an
 * upstream GeoServer WMS layer name (`PostGIS:VIIRS_2019`). The browser
 * fetches `/api/raster?layer=<id>&z=...&x=...&y=...`; the server-side
 * RasterClient does the upstream-layer lookup before calling GetMap.
 *
 * Live GeoServer discovery 2026-05-17 (TIN-1289). Annual VIIRS coverage
 * is 2012-2019 (8 years). Falchi World Atlas comes in two flavours:
 * `WA_2015` (styled) and `WA_2015_raw` (unstyled radiance values).
 *
 * Layers carry a `group` discriminator so the UI can render a year
 * picker for the VIIRS Annual family instead of 8 separate checkboxes.
 * Single-layer groups (Falchi, etc.) render as a plain toggle.
 */

export type LayerGroup = 'viirs_annual' | 'world_atlas' | 'world_atlas_raw' | 'atmospheric';

export interface RasterLayerDef {
	readonly id: string;
	/**
	 * GeoServer layer name for the QueryRaster proxy path. Mutually exclusive
	 * with `upstreamUrlTemplate`. Required for VIIRS / World Atlas layers that
	 * route through `RasterClient` → upstream GetMap.
	 */
	readonly upstreamLayer?: string;
	/**
	 * Direct WMTS / XYZ URL template (with `{z}`, `{x}`, `{y}`, optional
	 * `{TIME}`) for layers that bypass the GeoServer proxy. Used by the
	 * `atmospheric` group (NASA GIBS) — tiles fetched server-side and bucketed
	 * to `darkmap-atmospheric-tile` in the service worker.
	 */
	readonly upstreamUrlTemplate?: string;
	readonly label: string;
	readonly description: string;
	/** UI grouping: multi-layer groups (e.g. VIIRS annual / monthly) render as a single picker. */
	readonly group: LayerGroup;
	/** For multi-year groups, the year. Unused for single-layer groups. */
	readonly year?: number;
	readonly defaultEnabled: boolean;
	/** 0..1 opacity in the MapLibre raster source. */
	readonly opacity: number;
}

const viirs = (year: number, defaultEnabled = false): RasterLayerDef => ({
	id: `viirs_${year}`,
	upstreamLayer: `PostGIS:VIIRS_${year}`,
	label: `VIIRS ${year}`,
	description: `NOAA VIIRS DNB annual composite, ${year}.`,
	group: 'viirs_annual',
	year,
	defaultEnabled,
	opacity: 0.85,
});

export const LAYERS: ReadonlyArray<RasterLayerDef> = [
	viirs(2019, true),
	viirs(2018),
	viirs(2017),
	viirs(2016),
	viirs(2015),
	viirs(2014),
	viirs(2013),
	viirs(2012),
	{
		id: 'world_atlas_2015',
		upstreamLayer: 'PostGIS:WA_2015',
		label: 'World Atlas 2015',
		description: 'Falchi et al. 2016 World Atlas of Artificial Night Sky Brightness (styled).',
		group: 'world_atlas',
		defaultEnabled: false,
		opacity: 0.7,
	},
	{
		id: 'world_atlas_2015_raw',
		upstreamLayer: 'PostGIS:WA_2015_raw',
		label: 'World Atlas 2015 (raw)',
		description: 'Falchi 2016 World Atlas raw radiance (unstyled).',
		group: 'world_atlas_raw',
		defaultEnabled: false,
		opacity: 0.7,
	},
];

/**
 * MapLibre raster source URL template targeting our proxy. Atmospheric layers
 * carry `&kind=atmospheric` so the service worker can route the response to
 * `darkmap-atmospheric-tile` without importing the layer catalog into the SW.
 */
export const rasterUrlTemplate = (layerId: string): string => {
	const layer = LAYERS.find((l) => l.id === layerId);
	const base = `/api/raster?layer=${encodeURIComponent(layerId)}&z={z}&x={x}&y={y}`;
	return layer?.group === 'atmospheric' ? `${base}&kind=atmospheric` : base;
};

/** Default map center — Ithaca, NY (the lab fallback when geolocation is unavailable). */
export const FALLBACK_CENTER: readonly [number, number] = [-76.5019, 42.4434];
export const FALLBACK_ZOOM = 9;

/** All VIIRS annual layers, year-descending (most recent first). */
export const VIIRS_YEARS: ReadonlyArray<RasterLayerDef> = LAYERS.filter((l) => l.group === 'viirs_annual').sort(
	(a, b) => (b.year ?? 0) - (a.year ?? 0),
);
