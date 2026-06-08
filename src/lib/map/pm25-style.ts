import type { PropertyValueSpecification } from 'maplibre-gl';
import { type PaletteMode, paletteRamp } from '$lib/atmospheric/aqi';

export const PM25_UNKNOWN_COLOR = 'rgba(148, 163, 184, 0.72)';

const pm25Value = (): PropertyValueSpecification<number | null> => ['get', 'value'];

export const pm25HasNumericValueExpression = (): PropertyValueSpecification<boolean> => [
	'==',
	['typeof', pm25Value()],
	'number',
];

export const pm25HeatmapWeightExpression = (): PropertyValueSpecification<number> =>
	[
		'case',
		pm25HasNumericValueExpression(),
		['interpolate', ['linear'], pm25Value(), 0, 0, 100, 1],
		0,
	] as PropertyValueSpecification<number>;

// PM2.5 concentration (µg/m³) anchors for the dot ramp, paired with the AQI
// category each anchor falls in (Good → Very-unhealthy). The hexes come from
// the active palette ramp (`aqi.ts`) so a palette swap recolors the dots from
// the same source as the dashboard + categories — no inline literals.
const PM25_RAMP_STOPS: readonly [value: number, categoryIndex: number][] = [
	[0, 0], // Good
	[12, 1], // Moderate
	[35, 2], // Unhealthy for sensitive groups
	[55, 3], // Unhealthy
	[150, 4], // Very unhealthy
];

export const pm25CircleColorExpression = (mode: PaletteMode = 'airnow'): PropertyValueSpecification<string> => {
	const ramp = paletteRamp(mode);
	const stops = PM25_RAMP_STOPS.flatMap(([value, ci]) => [value, ramp[ci]]);
	return [
		'case',
		pm25HasNumericValueExpression(),
		['interpolate', ['linear'], pm25Value(), ...stops],
		PM25_UNKNOWN_COLOR,
	] as PropertyValueSpecification<string>;
};
