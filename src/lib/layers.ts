/**
 * Layer manifest. Each entry maps a friendly id (`viirs_2019`) to an
 * upstream GeoServer WMS layer name (`PostGIS:VIIRS_2019`). The browser
 * fetches `/api/raster?layer=<id>&z=...&x=...&y=...`; the server-side
 * RasterClient does the upstream-layer lookup before calling GetMap.
 *
 * Live GeoServer discovery 2026-05-17 (TIN-1289). Annual VIIRS coverage
 * is 2012-2019 (8 years). Falchi World Atlas ships as the styled
 * `WA_2015` overlay; the unstyled `WA_2015_raw` radiance grid is NOT a
 * public overlay — it is read only by the click-to-read point query
 * (see `server/raster/PointQuery.ts`, which surfaces raw mcd/m²).
 *
 * Layers carry a `group` discriminator so the UI can render a year
 * picker for the VIIRS Annual family instead of 8 separate checkboxes.
 * Single-layer groups (Falchi, etc.) render as a plain toggle.
 */

export type LayerGroup = 'viirs_annual' | 'world_atlas' | 'atmospheric';

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
	/**
	 * Endpoint that returns a GeoJSON FeatureCollection (with a `bbox=` query
	 * appended at fetch time). Indicates the layer is rendered as a
	 * MapLibre GeoJSON source + heatmap/circle layers rather than raster
	 * tiles. Used by `smog-openaq-pm25` (PR-F).
	 */
	readonly pointSourceUrl?: string;
	readonly label: string;
	readonly description: string;
	/** UI grouping: multi-layer groups (e.g. VIIRS annual / monthly) render as a single picker. */
	readonly group: LayerGroup;
	/** For multi-year groups, the year. Unused for single-layer groups. */
	readonly year?: number;
	readonly defaultEnabled: boolean;
	/** 0..1 opacity in the MapLibre raster source. */
	readonly opacity: number;
	/**
	 * Highest native XYZ/WMTS tile zoom for this source. MapLibre can overzoom
	 * beyond this level, but must not request higher upstream tile coordinates
	 * for fixed-depth WMTS matrix sets such as NASA GIBS Level9/6/5.
	 */
	readonly maxNativeZoom?: number;
	/** Attribution chip surfaced in MapLibre's attribution control (required for atmospheric layers). */
	readonly attribution?: string;
}

const GIBS_ATTRIBUTION = 'Imagery courtesy NASA EOSDIS GIBS';

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
		id: 'clouds-modis-terra',
		upstreamUrlTemplate:
			'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{TIME}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
		label: 'Clouds (MODIS Terra)',
		description: 'NASA GIBS MODIS Terra true-color, 250 m, daily AM pass — clouds, snow, smoke.',
		group: 'atmospheric',
		defaultEnabled: false,
		opacity: 0.75,
		maxNativeZoom: 9,
		attribution: GIBS_ATTRIBUTION,
	},
	{
		id: 'clouds-viirs-noaa20',
		upstreamUrlTemplate:
			'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/{TIME}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
		label: 'Clouds (VIIRS NOAA-20)',
		description: 'NASA GIBS VIIRS NOAA-20 true-color, 375 m, daily PM pass — pairs with MODIS Terra (AM).',
		group: 'atmospheric',
		defaultEnabled: false,
		opacity: 0.75,
		maxNativeZoom: 9,
		attribution: GIBS_ATTRIBUTION,
	},
	{
		id: 'aerosol-modis-aod',
		upstreamUrlTemplate:
			'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Combined_Value_Added_AOD/default/{TIME}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png',
		label: 'Aerosol AOD (MODIS)',
		description: 'NASA GIBS MODIS Combined Aerosol Optical Depth @ 550 nm, 2 km, daily — smoke / dust / urban haze.',
		group: 'atmospheric',
		defaultEnabled: false,
		opacity: 0.6,
		maxNativeZoom: 6,
		attribution: GIBS_ATTRIBUTION,
	},
	{
		id: 'water-vapor-airs',
		upstreamUrlTemplate:
			'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_Water_Vapor_5km_Day/default/{TIME}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png',
		label: 'Water vapor (MODIS Terra)',
		description: 'NASA GIBS MODIS Terra infrared water vapor, 5 km, daily daytime pass.',
		group: 'atmospheric',
		defaultEnabled: false,
		opacity: 0.55,
		maxNativeZoom: 6,
		attribution: GIBS_ATTRIBUTION,
	},
	{
		id: 'smog-openaq-pm25',
		pointSourceUrl: '/api/atmospheric/openaq',
		label: 'Smog (PM2.5)',
		description:
			'OpenAQ ground-station PM2.5, viewport-scoped. Heatmap when sensors are dense; markers in sparse areas.',
		group: 'atmospheric',
		defaultEnabled: false,
		opacity: 0.7,
		attribution: 'PM2.5 data by OpenAQ contributors (CC-BY)',
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
