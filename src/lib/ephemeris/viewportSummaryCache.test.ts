import { describe, expect, it } from 'vitest';
import type { EphemerisReadout, LatLon } from './EphemerisClient';
import { makeEphemerisViewportSummaryRequest } from './viewportSummary';
import { clearViewportRangeCache, viewportRangesFor } from './viewportSummaryCache';

const DAY = new Date('2026-06-21T12:00:00Z');
const BOUNDS = { north: 42.46, south: 42.42, west: -76.53, east: -76.48 };

const readoutFor = (location: LatLon, at: Date): EphemerisReadout => ({
	location,
	at,
	sun: { altitudeDeg: 0, azimuthDeg: 0 },
	moon: {
		altitudeDeg: 0,
		azimuthDeg: 0,
		illumination: 0.5,
		phaseDeg: 90,
		phaseName: 'first-quarter',
	},
	events: {
		astronomicalDawn: null,
		nauticalDawn: null,
		civilDawn: null,
		sunrise: null,
		solarNoon: null,
		sunset: null,
		civilDusk: new Date(Date.UTC(2026, 5, 21, 1, Math.round(location.lat * 10))),
		nauticalDusk: null,
		astronomicalDusk: null,
		moonrise: null,
		moonset: null,
	},
});

describe('viewportRangesFor', () => {
	it('reuses the in-flight promise for a matching tile-summary key', async () => {
		clearViewportRangeCache();
		const req = makeEphemerisViewportSummaryRequest({ bounds: BOUNDS, mapZoom: 13, time: DAY });
		expect(req).not.toBeNull();

		let calls = 0;
		const client = async (location: LatLon, at: Date): Promise<EphemerisReadout> => {
			calls += 1;
			return readoutFor(location, at);
		};

		const [a, b] = await Promise.all([viewportRangesFor(req!, client, DAY), viewportRangesFor(req!, client, DAY)]);
		expect(a.ranges).toEqual(b.ranges);
		expect(a.key).toBe(req!.key);
		expect(a.source).toBe('computed');
		expect(b.source).toBe('in-flight-cache');
		expect(b.computedAtMs).toBe(a.computedAtMs);
		expect(calls).toBe(req!.samplePoints.length);

		const cached = await viewportRangesFor(req!, client, DAY);
		expect(cached.source).toBe('memory-cache');
		expect(cached.computedAtMs).toBe(a.computedAtMs);
		expect(calls).toBe(req!.samplePoints.length);
	});

	it('evicts failed computations so the next request can retry', async () => {
		clearViewportRangeCache();
		const req = makeEphemerisViewportSummaryRequest({ bounds: BOUNDS, mapZoom: 13, time: DAY });
		expect(req).not.toBeNull();

		await expect(
			viewportRangesFor(
				req!,
				async () => {
					throw new Error('sample failure');
				},
				DAY,
			),
		).rejects.toThrow('sample failure');

		let calls = 0;
		const summary = await viewportRangesFor(
			req!,
			async (location, at) => {
				calls += 1;
				return readoutFor(location, at);
			},
			DAY,
		);
		expect(summary.source).toBe('computed');
		expect(calls).toBe(req!.samplePoints.length);
	});
});
