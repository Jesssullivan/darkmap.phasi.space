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

export type LayerGroup = 'viirs_annual' | 'viirs_monthly' | 'world_atlas' | 'world_atlas_raw';

export interface RasterLayerDef {
	readonly id: string;
	readonly upstreamLayer: string;
	readonly label: string;
	readonly description: string;
	/** UI grouping: multi-layer groups (e.g. VIIRS annual / monthly) render as a single picker. */
	readonly group: LayerGroup;
	/** For multi-year groups, the year. Unused for single-layer groups. */
	readonly year?: number;
	/** For VIIRS monthly composites, the 1..12 calendar month. */
	readonly month?: number;
	readonly defaultEnabled: boolean;
	/** 0..1 opacity in the MapLibre raster source. */
	readonly opacity: number;
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

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

const viirsMonthly = (year: number, month: number): RasterLayerDef => ({
	id: `viirs_${year}_${pad2(month)}`,
	// Upstream GeoServer namespace + layer name discovered via GetCapabilities
	// at www2.lightpollutionmap.info/geoserver/gwc/service/wms (2026-05-17).
	upstreamLayer: `lighttrends:viirs_npp_${year}${pad2(month)}`,
	label: `VIIRS ${year}-${pad2(month)}`,
	description: `NOAA VIIRS DNB monthly composite, ${year}-${pad2(month)}.`,
	group: 'viirs_monthly',
	year,
	month,
	defaultEnabled: false,
	opacity: 0.85,
});

/**
 * VIIRS monthly composite coverage. Suomi-NPP started returning useable
 * DNB data in April 2012. The upstream `lighttrends:` namespace currently
 * has months through April 2026 (last verified 2026-05-17 against
 * GeoServer GetCapabilities). The TimeDock in TIN-1301/sub-6 will surface
 * a calendar slider over this range.
 */
export const VIIRS_MONTHLY_START = { year: 2012, month: 4 } as const;
export const VIIRS_MONTHLY_END = { year: 2026, month: 4 } as const;

const generateMonthlyLayers = (): RasterLayerDef[] => {
	// Widen the `as const` literals to plain numbers inside the loop so
	// `y === VIIRS_MONTHLY_START.year` isn't a literal-type comparison.
	const startYear: number = VIIRS_MONTHLY_START.year;
	const startMonth: number = VIIRS_MONTHLY_START.month;
	const endYear: number = VIIRS_MONTHLY_END.year;
	const endMonth: number = VIIRS_MONTHLY_END.month;
	const out: RasterLayerDef[] = [];
	for (let y = startYear; y <= endYear; y++) {
		const startM = y === startYear ? startMonth : 1;
		const endM = y === endYear ? endMonth : 12;
		for (let m = startM; m <= endM; m++) {
			out.push(viirsMonthly(y, m));
		}
	}
	return out;
};

const MONTHLY_LAYERS = generateMonthlyLayers();

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
	...MONTHLY_LAYERS,
];

/** MapLibre raster source URL template targeting our proxy. */
export const rasterUrlTemplate = (layerId: string): string =>
	`/api/raster?layer=${encodeURIComponent(layerId)}&z={z}&x={x}&y={y}`;

/** Default map center — Ithaca, NY (the lab fallback when geolocation is unavailable). */
export const FALLBACK_CENTER: readonly [number, number] = [-76.5019, 42.4434];
export const FALLBACK_ZOOM = 9;

/** All VIIRS annual layers, year-descending (most recent first). */
export const VIIRS_YEARS: ReadonlyArray<RasterLayerDef> = LAYERS.filter((l) => l.group === 'viirs_annual').sort(
	(a, b) => (b.year ?? 0) - (a.year ?? 0),
);

/**
 * All VIIRS monthly layers, sorted by date ascending (Apr 2012 first).
 * The TimeDock slider in TIN-1301/sub-6 indexes into this list.
 */
export const VIIRS_MONTHS: ReadonlyArray<RasterLayerDef> = LAYERS.filter((l) => l.group === 'viirs_monthly').sort(
	(a, b) => {
		const ay = a.year ?? 0;
		const by = b.year ?? 0;
		if (ay !== by) return ay - by;
		return (a.month ?? 0) - (b.month ?? 0);
	},
);
