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
	 * Self-hosted tile binding (RV1/RV12/RV13). A bound layer is served only
	 * from our own XYZ store under `DARKMAP_RASTER_TILE_BASE_URL`
	 * (`${base}/${path}/{z}/{x}/{y}.png`), never from the upstream WMS, and its
	 * `label` / `description` / `attribution` describe the stored product.
	 */
	readonly selfHosted?: {
		/** Store path, e.g. `gibs-viirs-black-marble/2016`. */
		readonly path: string;
		/** Deepest rendered zoom (also the client `maxNativeZoom`). */
		readonly maxZoom: number;
		/** Provenance exposed as the `x-darkmap-raster-product` header. */
		readonly product: string;
		/** Year of the data actually stored (may differ from the slot `year`). */
		readonly dataYear: number;
	};
	/** Short text for the year chip when it must differ from `year`. */
	readonly chipLabel?: string;
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

const viirs = (year: number, defaultEnabled = false, opacity = 0.85): RasterLayerDef => ({
	id: `viirs_${year}`,
	upstreamLayer: `PostGIS:VIIRS_${year}`,
	label: `VIIRS ${year}`,
	description: `NOAA VIIRS DNB annual composite, ${year}.`,
	group: 'viirs_annual',
	year,
	defaultEnabled,
	opacity,
});

const VNP46A4_ATTRIBUTION =
	'NASA Black Marble VNP46A4 collection 002 (VIIRS Land SIPS, LAADS DAAC), doi:10.5067/VIIRS/VNP46A4.002';

/**
 * RV12: the newest VIIRS slot (`viirs_2019`, kept as the id so permalinks, the
 * service-worker cache and the Public smoke keep working) is served from our
 * self-hosted render of NASA Black Marble VNP46A4 collection 002, the 2019
 * annual composite (AllAngle_Composite_Snow_Free, quality flag 0 only),
 * EPSG:3857 z0..z8 (docs/SELF_HOSTED_RASTER.md). It replaces the interim
 * mirror of NASA GIBS VIIRS_Black_Marble 2016 (`gibs-viirs-black-marble/2016`,
 * kept in the store for rollback). The tiles use the pilot radiance palette,
 * not the upstream VIIRS color scale, so the rail shows the description
 * instead of that legend.
 */
export const VIIRS_2019_SLOT: RasterLayerDef = {
	...viirs(2019, true, 0.25),
	label: 'VIIRS 2019 (VNP46A4)',
	description:
		'NASA Black Marble VNP46A4 collection 002 annual composite, 2019 (VIIRS Day/Night Band, Suomi NPP; AllAngle_Composite_Snow_Free, quality-filtered), rendered and served by darkmap.',
	selfHosted: {
		path: 'vnp46a4-002/2019',
		maxZoom: 8,
		product: 'NASA Black Marble VNP46A4.002 2019 annual composite (AllAngle_Composite_Snow_Free)',
		dataYear: 2019,
	},
	maxNativeZoom: 8,
	attribution: VNP46A4_ATTRIBUTION,
};

export const LAYERS: ReadonlyArray<RasterLayerDef> = [
	// Default display: the newest VIIRS slot (RV12: NASA Black Marble VNP46A4
	// 2019, self-hosted) at a faint 25% so it reads as a subtle wash over the OSM basemap
	// (paired with World Atlas 25% below). Other years toggle at 85%.
	VIIRS_2019_SLOT,
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
		// On by default at a faint 25% — pairs with the newest VIIRS slot at 25% over OSM.
		defaultEnabled: true,
		opacity: 0.25,
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
			'OpenAQ ground-station PM2.5 observations, viewport-scoped. Dense station heatmap, sparse markers, unknown readings excluded. The density field leans downwind using a single representative wind (from your last point readout) applied uniformly across the view — an approximation, since real wind varies across the map.',
		group: 'atmospheric',
		defaultEnabled: false,
		opacity: 0.7,
		attribution: 'PM2.5 data by OpenAQ contributors (CC-BY)',
	},
];

/**
 * Stable UTC day key used by daily atmospheric products and cache keys.
 */
export const utcDayKey = (date: Date): string => {
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	const day = String(date.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
};

export interface RasterUrlTemplateOptions {
	/**
	 * Explicit daily product date for atmospheric layers. Pass a UTC-day string
	 * (`YYYY-MM-DD`) or a Date; non-atmospheric layers ignore it.
	 */
	readonly time?: string | Date;
}

const normalizeTemplateTime = (time: string | Date | undefined): string | undefined =>
	time instanceof Date ? utcDayKey(time) : time;

/**
 * MapLibre raster source URL template targeting our proxy. Atmospheric layers
 * carry `&kind=atmospheric` so the service worker can route the response to
 * `darkmap-atmospheric-tile` without importing the layer catalog into the SW.
 * When a daily product date is known, atmospheric templates also carry
 * `time=YYYY-MM-DD` so GIBS, health badges, and cache keys agree.
 */
export const rasterUrlTemplate = (layerId: string, options: RasterUrlTemplateOptions = {}): string => {
	const layer = LAYERS.find((l) => l.id === layerId);
	const base = `/api/raster?layer=${encodeURIComponent(layerId)}&z={z}&x={x}&y={y}`;
	if (layer?.group !== 'atmospheric') return base;
	const time = normalizeTemplateTime(options.time);
	return `${base}&kind=atmospheric${time ? `&time=${encodeURIComponent(time)}` : ''}`;
};

/** Default map center — Ithaca, NY (the lab fallback when geolocation is unavailable). */
export const FALLBACK_CENTER: readonly [number, number] = [-76.5019, 42.4434];
export const FALLBACK_ZOOM = 9;

/** All VIIRS annual layers, year-descending (most recent first). */
export const VIIRS_YEARS: ReadonlyArray<RasterLayerDef> = LAYERS.filter((l) => l.group === 'viirs_annual').sort(
	(a, b) => (b.year ?? 0) - (a.year ?? 0),
);
