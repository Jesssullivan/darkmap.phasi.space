import type { PropertyValueSpecification } from 'maplibre-gl';

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

export const pm25CircleColorExpression = (): PropertyValueSpecification<string> =>
	[
		'case',
		pm25HasNumericValueExpression(),
		['interpolate', ['linear'], pm25Value(), 0, '#00e400', 12, '#ffff00', 35, '#ff7e00', 55, '#ff0000', 150, '#8f3f97'],
		PM25_UNKNOWN_COLOR,
	] as PropertyValueSpecification<string>;
