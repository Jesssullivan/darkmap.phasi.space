import { describe, expect, it } from 'vitest';
import { buildViewportSummary, type SummaryStation } from './viewport-summary';

const stn = (value: number | null, pollutants: Record<string, number | null> = {}): SummaryStation => ({
	value,
	pollutants,
});

describe('buildViewportSummary', () => {
	it('counts stations and the subset reporting PM2.5', () => {
		const s = buildViewportSummary([stn(12), stn(null, { o3: 30 }), stn(8)]);
		expect(s.stationCount).toBe(3);
		expect(s.pm25StationCount).toBe(2);
	});

	it('computes the PM2.5 AQI spread only over reporting stations', () => {
		// 0 and 12.0 µg/m³ → sub-indices 0 and 50 (Good band, linear); 35.5 → 101 (USG).
		const s = buildViewportSummary([stn(0), stn(12), stn(35.5)]);
		expect(s.aqi).not.toBeNull();
		expect(s.aqi!.min).toBe(0);
		expect(s.aqi!.max).toBeGreaterThanOrEqual(100);
		expect(s.aqi!.maxCategory.name).toMatch(/sensitive|unhealthy/i);
	});

	it('returns null AQI when no station reports PM2.5 (never implies clean)', () => {
		const s = buildViewportSummary([stn(null, { o3: 40 }), stn(null, { no2: 10 })]);
		expect(s.aqi).toBeNull();
		expect(s.pm25StationCount).toBe(0);
	});

	it('null PM2.5 is present-but-no-data, not 0', () => {
		const s = buildViewportSummary([stn(null), stn(10)]);
		// the null station does not drag the spread toward 0
		expect(s.aqi!.min).toBeGreaterThan(0);
		expect(s.pm25StationCount).toBe(1);
	});

	it('tallies per-pollutant station counts and drops zero-count pollutants', () => {
		const s = buildViewportSummary([stn(12, { o3: 30, no2: 5 }), stn(8, { o3: 25 }), stn(null, { so2: 2 })]);
		const counts = Object.fromEntries(s.pollutantCounts.map((c) => [c.pollutant, c.count]));
		expect(counts.pm25).toBe(2);
		expect(counts.o3).toBe(2);
		expect(counts.no2).toBe(1);
		expect(counts.so2).toBe(1);
		expect(counts.pm10).toBeUndefined(); // none reported → dropped
		expect(counts.co).toBeUndefined();
	});

	it('takes the median of an even count as the mean of the middle pair', () => {
		// pm25 0,12 → sub-indices ~0 and ~50 → median ~25.
		const s = buildViewportSummary([stn(0), stn(12)]);
		expect(s.aqi!.median).toBeGreaterThan(20);
		expect(s.aqi!.median).toBeLessThan(30);
	});

	it('handles an empty collection honestly', () => {
		const s = buildViewportSummary([]);
		expect(s.stationCount).toBe(0);
		expect(s.aqi).toBeNull();
		expect(s.pollutantCounts).toEqual([]);
	});
});
