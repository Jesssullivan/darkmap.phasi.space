/**
 * Per-atmospheric-layer capability table — drives the AtmosphericTileService
 * (#199). Holds the WMTS-side limits the proxy needs to respect:
 *
 *   - Native max zoom (upstream tile pyramid depth)
 *   - Date cadence — 'daily' vs 'static'
 *   - Publication-lag hours — how long after UTC midnight before today's
 *     tile is reliably published. Used to pick a default time that doesn't
 *     404 on first-paint-of-the-day.
 *
 * Lives separately from `RasterLayerDef` because these are intrinsic to the
 * GIBS source, not part of the layer-rendering contract. Future RT-grade
 * sources (TROPOMI, GOES-R) get new rows here without re-touching the
 * layer manifest.
 */

import type { RasterLayerDef } from './layers';

export type AtmosphericDateCadence = 'daily' | 'static';

export interface AtmosphericCapability {
	readonly maxNativeZoom: number;
	readonly dateCadence: AtmosphericDateCadence;
	/**
	 * Hours after UTC midnight when today's tile is reliably published. GIBS
	 * publishes NRT at T+3h SLA; some products lag longer (AIRS is afternoon
	 * publish). We pad to be safe — first-paint quality matters more than
	 * sub-half-day freshness for atmospheric overlays.
	 */
	readonly publicationLagHours: number;
}

export const ATMOSPHERIC_CAPABILITIES: Readonly<Record<string, AtmosphericCapability>> = {
	'clouds-modis-terra': { maxNativeZoom: 9, dateCadence: 'daily', publicationLagHours: 6 },
	'clouds-viirs-noaa20': { maxNativeZoom: 9, dateCadence: 'daily', publicationLagHours: 6 },
	// MODIS Combined AOD is a daily science product released ~midday UTC.
	'aerosol-modis-aod': { maxNativeZoom: 6, dateCadence: 'daily', publicationLagHours: 18 },
	// AIRS PWAT publishes in the afternoon UTC window. Native pyramid is
	// Level6 in GIBS even though the dataset is ~45 km resolution.
	'water-vapor-airs': { maxNativeZoom: 6, dateCadence: 'daily', publicationLagHours: 20 },
};

/** Return the capability row for an atmospheric layer, or undefined if not registered. */
export const capabilityFor = (layerId: string): AtmosphericCapability | undefined => ATMOSPHERIC_CAPABILITIES[layerId];

/**
 * Pick a default date string for the upstream WMTS URL given a capability.
 * Static cadence returns the literal `default` keyword that GIBS resolves to
 * the latest available tile. Daily cadence steps back by the publication-lag
 * window so first-paint requests don't 404 on tiles still propagating.
 */
export const defaultTimeForCapability = (cap: AtmosphericCapability, now: Date = new Date()): string => {
	if (cap.dateCadence === 'static') return 'default';
	const lagMs = cap.publicationLagHours * 3600 * 1000;
	// If we're past today's publication threshold, today is fine; else step
	// back one calendar day.
	const utcHourOfDay = now.getUTCHours() + now.getUTCMinutes() / 60;
	if (utcHourOfDay >= cap.publicationLagHours) {
		return now.toISOString().slice(0, 10);
	}
	const yesterday = new Date(now.getTime() - lagMs);
	return yesterday.toISOString().slice(0, 10);
};

/**
 * GIBS WMTS tiles more than 48 h in the past are frozen upstream — once a
 * date is past the science-quality reprocessing window the raster never
 * changes. Freeze them in our CDN + browser cache forever; fresher tiles
 * (or static keyword) get a short cache window.
 */
export const isImmutableTime = (timeStr: string, now: Date = new Date()): boolean => {
	if (timeStr === 'default') return false;
	const parsed = Date.parse(timeStr);
	if (!Number.isFinite(parsed)) return false;
	return now.getTime() - parsed > 48 * 3600 * 1000;
};

/** Compose the upstream URL by substituting all four template slots (each may appear more than once). */
export const expandAtmosphericUrl = (template: string, z: number, x: number, y: number, time: string): string =>
	template
		.replaceAll('{z}', String(z))
		.replaceAll('{x}', String(x))
		.replaceAll('{y}', String(y))
		.replaceAll('{TIME}', time);

/** Type-narrowing helper. */
export const isAtmosphericLayer = (
	layerDef: RasterLayerDef,
): layerDef is RasterLayerDef & { upstreamUrlTemplate: string } =>
	layerDef.group === 'atmospheric' && typeof layerDef.upstreamUrlTemplate === 'string';
