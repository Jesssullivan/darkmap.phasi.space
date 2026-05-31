import { describe, expect, it } from 'vitest';
import { buildStationFeature, selectFreshLocations, type V3Latest, type V3Location } from './openaq-shape';

const NOW = Date.parse('2026-05-31T08:00:00Z');
const DAY = 24 * 3600 * 1000;
const FRESH = '2026-05-31T07:00:00Z'; // 1 h old
const OLD = '2022-05-05T22:00:00Z'; // years stale

const loc = (over: Partial<V3Location> = {}): V3Location => ({
	id: 1,
	name: 'Test',
	coordinates: { latitude: 34, longitude: -118 },
	datetimeLast: { utc: FRESH },
	sensors: [{ id: 10, parameter: { name: 'pm25', units: 'µg/m³' } }],
	...over,
});

describe('selectFreshLocations', () => {
	it('keeps fresh criteria-pollutant locations, drops stale ones', () => {
		const ls = [loc({ id: 1, datetimeLast: { utc: FRESH } }), loc({ id: 2, datetimeLast: { utc: OLD } })];
		const out = selectFreshLocations(ls, NOW, DAY, 50);
		expect(out.map((l) => l.id)).toEqual([1]);
	});

	it('drops locations with no coords or no criteria sensor', () => {
		const ls = [
			loc({ id: 1 }),
			loc({ id: 2, coordinates: undefined }),
			loc({ id: 3, sensors: [{ id: 9, parameter: { name: 'bc' } }] }), // black carbon — not a criteria pollutant
		];
		expect(selectFreshLocations(ls, NOW, DAY, 50).map((l) => l.id)).toEqual([1]);
	});

	it('sorts most-recent-first and caps to max', () => {
		const ls = [
			loc({ id: 1, datetimeLast: { utc: '2026-05-31T03:00:00Z' } }),
			loc({ id: 2, datetimeLast: { utc: '2026-05-31T07:30:00Z' } }),
			loc({ id: 3, datetimeLast: { utc: '2026-05-31T06:00:00Z' } }),
		];
		expect(selectFreshLocations(ls, NOW, DAY, 2).map((l) => l.id)).toEqual([2, 3]);
	});

	it('drops future-dated and unparseable timestamps', () => {
		const ls = [
			loc({ id: 1, datetimeLast: { utc: '2099-01-01T00:00:00Z' } }),
			loc({ id: 2, datetimeLast: { utc: 'not-a-date' } }),
		];
		expect(selectFreshLocations(ls, NOW, DAY, 50)).toEqual([]);
	});
});

describe('buildStationFeature', () => {
	const latest = (over: Partial<V3Latest> = {}): V3Latest => ({
		value: 12,
		sensorsId: 10,
		datetime: { utc: FRESH },
		...over,
	});

	it('joins sensor → latest value and mirrors PM2.5 into `value`', () => {
		const f = buildStationFeature(loc(), [latest()], NOW, DAY);
		expect(f).not.toBeNull();
		expect(f!.properties.value).toBe(12);
		expect(f!.properties.pollutants.pm25).toEqual({ value: 12, units: 'µg/m³' });
		expect(f!.geometry.coordinates).toEqual([-118, 34]);
	});

	it('keeps multiple criteria pollutants with their units', () => {
		const l = loc({
			sensors: [
				{ id: 10, parameter: { name: 'pm25', units: 'µg/m³' } },
				{ id: 11, parameter: { name: 'o3', units: 'ppm' } },
			],
		});
		const f = buildStationFeature(
			l,
			[latest({ sensorsId: 10, value: 8 }), latest({ sensorsId: 11, value: 0.04 })],
			NOW,
			DAY,
		);
		expect(f!.properties.pollutants.pm25).toEqual({ value: 8, units: 'µg/m³' });
		expect(f!.properties.pollutants.o3).toEqual({ value: 0.04, units: 'ppm' });
	});

	it('skips stale readings (older than the freshness window)', () => {
		const f = buildStationFeature(loc(), [latest({ datetime: { utc: OLD } })], NOW, DAY);
		expect(f).toBeNull(); // its only reading is stale → no fresh pollutant
	});

	it('ignores readings whose sensorsId is not a criteria sensor at this location', () => {
		const f = buildStationFeature(loc(), [latest({ sensorsId: 999, value: 50 })], NOW, DAY);
		expect(f).toBeNull();
	});

	it('returns null with no usable latest, and value:null when PM2.5 absent but another pollutant is fresh', () => {
		expect(buildStationFeature(loc(), [], NOW, DAY)).toBeNull();
		const l = loc({ sensors: [{ id: 11, parameter: { name: 'no2', units: 'ppb' } }] });
		const f = buildStationFeature(l, [latest({ sensorsId: 11, value: 20 })], NOW, DAY);
		expect(f!.properties.value).toBeNull();
		expect(f!.properties.pollutants.no2).toEqual({ value: 20, units: 'ppb' });
	});
});
