import { describe, expect, it } from 'vitest';
import {
	PM25_UNKNOWN_COLOR,
	pm25CircleColorExpression,
	pm25HasNumericValueExpression,
	pm25HeatmapWeightExpression,
} from './pm25-style';

describe('PM2.5 MapLibre paint expressions', () => {
	it('gates numeric readings by typeof instead of coalescing null to zero', () => {
		expect(pm25HasNumericValueExpression()).toEqual(['==', ['typeof', ['get', 'value']], 'number']);
	});

	it('excludes null and missing PM2.5 readings from heatmap density', () => {
		const expr = pm25HeatmapWeightExpression();

		expect(expr).toEqual([
			'case',
			['==', ['typeof', ['get', 'value']], 'number'],
			['interpolate', ['linear'], ['get', 'value'], 0, 0, 100, 1],
			0,
		]);
		expect(JSON.stringify(expr)).not.toContain('coalesce');
	});

	it('renders unknown PM2.5 markers with an explicit unknown color', () => {
		const expr = pm25CircleColorExpression();
		const serialized = JSON.stringify(expr);

		expect(serialized).toContain(PM25_UNKNOWN_COLOR);
		expect(serialized).not.toContain('coalesce');
	});
});
