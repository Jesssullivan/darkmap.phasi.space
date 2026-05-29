/**
 * Color ramps extracted from upstream GeoServer SLD (2026-05-17).
 *
 *   curl 'https://www2.lightpollutionmap.info/geoserver/wms?service=WMS&version=1.1.1&request=GetStyles&layers=PostGIS:VIIRS_2019'
 *   curl 'https://www2.lightpollutionmap.info/geoserver/wms?service=WMS&version=1.1.1&request=GetStyles&layers=PostGIS:WA_2015'
 *
 * Each ramp is the default UserStyle's first FeatureTypeStyle ColorMap.
 * Quantities are in the layer's native unit (VIIRS: styled 0..255 byte;
 * WA_2015: mcd/m² per the Falchi 2016 atlas).
 */

export interface ColorStop {
	readonly color: string;
	readonly value: number;
}

export interface ColorRamp {
	readonly stops: ReadonlyArray<ColorStop>;
	/** Unit string for legend tick labels (empty if dimensionless). */
	readonly unit: string;
	/** Human-friendly axis name. */
	readonly axisLabel: string;
	/** Optional log scale (WA_2015 spans 5 orders of magnitude). */
	readonly logScale?: boolean;
}

export const VIIRS_RAMP: ColorRamp = {
	axisLabel: 'VIIRS radiance (styled)',
	unit: '',
	stops: [
		{ color: '#000000', value: 1 },
		{ color: '#051637', value: 10 },
		{ color: '#20998F', value: 35 },
		{ color: '#10BA47', value: 56 },
		{ color: '#00DB00', value: 69 },
		{ color: '#55E700', value: 74 },
		{ color: '#AAF300', value: 96 },
		{ color: '#FFFF00', value: 128 },
		{ color: '#F9DF06', value: 140 },
		{ color: '#F3C00C', value: 162 },
		{ color: '#EDA113', value: 192 },
		{ color: '#C2523C', value: 212 },
		{ color: '#B92927', value: 232 },
		{ color: '#B00012', value: 250 },
	],
};

export const WORLD_ATLAS_RAMP: ColorRamp = {
	axisLabel: 'Artificial radiance',
	unit: ' mcd/m²',
	logScale: true,
	stops: [
		{ color: '#000000', value: 0 },
		{ color: '#4d4d4d', value: 0.00261 },
		{ color: '#808080', value: 0.00435 },
		{ color: '#002573', value: 0.0087 },
		{ color: '#004eb3', value: 0.0174 },
		{ color: '#0092ce', value: 0.0348 },
		{ color: '#2e8a00', value: 0.0696 },
		{ color: '#a9a800', value: 0.139 },
		{ color: '#ffff00', value: 0.278 },
		{ color: '#ff5500', value: 0.557 },
		{ color: '#e60000', value: 1.11 },
		{ color: '#df72ff', value: 2.23 },
		{ color: '#e0bdff', value: 4.45 },
		{ color: '#f0deff', value: 8.91 },
		{ color: '#FFFFFF', value: 17.82 },
	],
};

/** Pick the right ramp for a layer's upstream identifier. */
export function rampFor(upstreamLayer: string): ColorRamp | undefined {
	if (upstreamLayer.startsWith('PostGIS:VIIRS_')) return VIIRS_RAMP;
	if (upstreamLayer === 'PostGIS:WA_2015') return WORLD_ATLAS_RAMP;
	return undefined;
}
