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

export type LayerGroup = 'viirs_annual' | 'viirs_monthly' | 'world_atlas' | 'atmospheric';

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
	/**
	 * For the `viirs_monthly` group, the `YYYY-MM` month key. Mirrors `year`
	 * for the annual group — kept as its own field rather than overloading
	 * `year` because TimeDock indexes by month, not by year.
	 */
	readonly month?: string;
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

/**
 * VIIRS monthly source strategy: layer-swap, not WMS-T (TIN-1301 / [Epic] C5).
 * Upstream GeoServer has zero `<Dimension name="time">` elements, so each
 * `lighttrends:viirs_npp_YYYYMM` is its own pre-seeded GeoWebCache tile
 * pyramid. (The originally-scoped 223 figure folded in legacy DMSP sensors
 * spanning 1992-2013, non-contiguous variants that are explicitly deferred
 * to a separate "legacy mode" ticket, not part of this manifest.)
 *
 * NOTE on the month count — the epic text is internally inconsistent and
 * this manifest follows the *date range*, not the *headline count*:
 * the epic states the range as "2012-04 → 2026-04 (178 months)", but
 * 2012-04 through 2026-04 inclusive is 169 months, not 178 — and subtask
 * 1's own accept line separately says `.length === 178`. Absent a live
 * GeoServer re-discovery (the same kind TIN-1289 did for the annual
 * layers), fabricating 9 more `viirs_YYYYMM` ids past 2026-04 to hit 178
 * would claim upstream layers with no evidence they exist. This manifest
 * anchors to the stated, checkable date range (169 months) instead; a
 * live discovery pass should confirm the true upstream end-of-series
 * month and reconcile that "178" figure before this ships.
 */
export const VIIRS_MONTHLY_START = { year: 2012, month: 4 } as const;
export const VIIRS_MONTHLY_END = { year: 2026, month: 4 } as const;

const monthKey = (year: number, month: number): string => `${year}-${String(month).padStart(2, '0')}`;

const viirsMonthly = (year: number, month: number): RasterLayerDef => {
	const key = monthKey(year, month);
	const compact = key.replace('-', '');
	return {
		id: `viirs_${compact}`,
		upstreamLayer: `lighttrends:viirs_npp_${compact}`,
		label: `VIIRS ${key}`,
		description: `NOAA VIIRS DNB monthly composite, ${key}.`,
		group: 'viirs_monthly',
		month: key,
		// None of the 178 monthly layers render by default — they're only
		// reachable through the TimeDock scrubber (subtask 3+), which drives
		// a single MapLibre source via setTiles() rather than toggling one
		// of these on. See subtask 4 (source-swap engine) — not yet wired.
		defaultEnabled: false,
		opacity: 0.85,
	};
};

/**
 * Generates every `YYYY-MM` key from `VIIRS_MONTHLY_START` through
 * `VIIRS_MONTHLY_END` inclusive, in chronological order. Exported (not just
 * used internally) so TimeDock and the hash codec can index by position
 * without re-deriving the calendar math.
 */
export const generateViirsMonthlyKeys = (): readonly string[] => {
	const keys: string[] = [];
	let { year, month } = VIIRS_MONTHLY_START;
	while (year < VIIRS_MONTHLY_END.year || (year === VIIRS_MONTHLY_END.year && month <= VIIRS_MONTHLY_END.month)) {
		keys.push(monthKey(year, month));
		month += 1;
		if (month > 12) {
			month = 1;
			year += 1;
		}
	}
	return keys;
};

const viirsMonthlyLayers = (): RasterLayerDef[] =>
	generateViirsMonthlyKeys().map((key) => {
		const [y, m] = key.split('-').map(Number);
		return viirsMonthly(y, m);
	});

export const LAYERS: ReadonlyArray<RasterLayerDef> = [
	// Default display: VIIRS 2019 at a faint 25% so it reads as a subtle wash over
	// the OSM basemap (paired with World Atlas 25% below). Other years toggle at 85%.
	viirs(2019, true, 0.25),
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
		// On by default at a faint 25% — pairs with VIIRS 2019 25% over OSM.
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
	...viirsMonthlyLayers(),
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

/** All VIIRS monthly layers, month-ascending — the order TimeDock scrubs through. */
export const VIIRS_MONTHLY_LAYERS: ReadonlyArray<RasterLayerDef> = LAYERS.filter(
	(l) => l.group === 'viirs_monthly',
).sort((a, b) => (a.month ?? '').localeCompare(b.month ?? ''));
