import { describe, expect, it } from 'vitest';
import type { EphemerisReadout } from './EphemerisClient';
import {
	ephemerisSummaryTileZoom,
	makeEphemerisViewportSummaryRequest,
	summarizeEventRanges,
	tileCoverForBounds,
	tileCoverKey,
	webMercatorTileBounds,
	type EphemerisEventKey,
} from './viewportSummary';

const DAY = new Date('2026-06-21T12:00:00Z');
const NEXT_DAY = new Date('2026-06-22T12:00:00Z');

const readout = (events: Partial<Record<EphemerisEventKey, string>>): EphemerisReadout => ({
	location: { lat: 0, lon: 0 },
	at: DAY,
	sun: { altitudeDeg: 0, azimuthDeg: 0 },
	moon: {
		altitudeDeg: 0,
		azimuthDeg: 0,
		illumination: 0.5,
		phaseDeg: 90,
		phaseName: 'first-quarter',
	},
	events: {
		astronomicalDawn: events.astronomicalDawn ? new Date(events.astronomicalDawn) : null,
		nauticalDawn: events.nauticalDawn ? new Date(events.nauticalDawn) : null,
		civilDawn: events.civilDawn ? new Date(events.civilDawn) : null,
		sunrise: events.sunrise ? new Date(events.sunrise) : null,
		solarNoon: events.solarNoon ? new Date(events.solarNoon) : null,
		sunset: events.sunset ? new Date(events.sunset) : null,
		civilDusk: events.civilDusk ? new Date(events.civilDusk) : null,
		nauticalDusk: events.nauticalDusk ? new Date(events.nauticalDusk) : null,
		astronomicalDusk: events.astronomicalDusk ? new Date(events.astronomicalDusk) : null,
		moonrise: null,
		moonset: null,
	},
});

describe('ephemerisSummaryTileZoom', () => {
	it('uses coarse, bounded zoom bands for viewport summaries', () => {
		expect(ephemerisSummaryTileZoom(undefined)).toBe(8);
		expect(ephemerisSummaryTileZoom(3.2)).toBe(5);
		expect(ephemerisSummaryTileZoom(6.5)).toBe(6);
		expect(ephemerisSummaryTileZoom(9.9)).toBe(7);
		expect(ephemerisSummaryTileZoom(14)).toBe(8);
	});
});

describe('tileCoverForBounds', () => {
	it('normalizes a viewport to a compact tile-cover key', () => {
		const cover = tileCoverForBounds({ north: 42.5, south: 42.4, west: -76.6, east: -76.5 }, 8);
		expect(cover).not.toBeNull();
		expect(tileCoverKey(cover!)).toMatch(/^z8:x\d+:y\d+$/);
	});

	it('encodes antimeridian crossings as two x ranges', () => {
		const cover = tileCoverForBounds({ north: 1, south: -1, west: 179, east: -179 }, 8);
		expect(cover?.xRanges).toHaveLength(2);
		expect(tileCoverKey(cover!)).toContain(',');
	});

	it('keeps a full-world longitude span as a complete x range', () => {
		const cover = tileCoverForBounds({ north: 1, south: -1, west: -180, east: 180 }, 5);
		expect(cover?.xRanges).toEqual([{ from: 0, to: 31 }]);
	});

	it('keeps exact east=180 bounds on the high x edge', () => {
		const cover = tileCoverForBounds({ north: 1, south: -1, west: 170, east: 180 }, 8);
		expect(cover?.xRanges).toEqual([{ from: 248, to: 255 }]);
	});
});

describe('makeEphemerisViewportSummaryRequest', () => {
	it('keeps small mobile pans inside the same summary key', () => {
		const a = makeEphemerisViewportSummaryRequest({
			bounds: { north: 42.46, south: 42.42, west: -76.53, east: -76.48 },
			mapZoom: 13,
			time: DAY,
		});
		const b = makeEphemerisViewportSummaryRequest({
			bounds: { north: 42.465, south: 42.425, west: -76.525, east: -76.475 },
			mapZoom: 13,
			time: DAY,
		});
		expect(a?.key).toBe(b?.key);
		expect(a?.samplePoints).toEqual(b?.samplePoints);
	});

	it('changes key at a tile boundary', () => {
		const tile = webMercatorTileBounds({ z: 8, x: 73, y: 94 });
		const westInside = makeEphemerisViewportSummaryRequest({
			bounds: {
				north: tile.north - 0.01,
				south: tile.north - 0.05,
				west: tile.west + 0.01,
				east: tile.west + 0.05,
			},
			mapZoom: 13,
			time: DAY,
		});
		const eastAcrossBoundary = makeEphemerisViewportSummaryRequest({
			bounds: {
				north: tile.north - 0.01,
				south: tile.north - 0.05,
				west: tile.east + 0.01,
				east: tile.east + 0.05,
			},
			mapZoom: 13,
			time: DAY,
		});
		expect(westInside?.key).not.toBe(eastAcrossBoundary?.key);
	});

	it('includes UTC day in the key', () => {
		const bounds = { north: 42.46, south: 42.42, west: -76.53, east: -76.48 };
		const a = makeEphemerisViewportSummaryRequest({ bounds, mapZoom: 13, time: DAY });
		const b = makeEphemerisViewportSummaryRequest({ bounds, mapZoom: 13, time: NEXT_DAY });
		expect(a?.key).not.toBe(b?.key);
	});

	it('returns null for degenerate bounds', () => {
		expect(
			makeEphemerisViewportSummaryRequest({
				bounds: { north: 42, south: 42, west: -77, east: -76 },
				mapZoom: 13,
				time: DAY,
			}),
		).toBeNull();
	});

	it('samples full-world longitude covers without collapsing the antimeridian', () => {
		const req = makeEphemerisViewportSummaryRequest({
			bounds: { north: 1, south: -1, west: -180, east: 180 },
			mapZoom: 3,
			time: DAY,
		});
		expect(req?.canonicalBounds).toMatchObject({ west: -180, east: 180 });
		expect(req?.samplePoints).toHaveLength(16);
	});
});

describe('summarizeEventRanges', () => {
	it('summarizes min and max for each event while skipping nulls', () => {
		const summary = summarizeEventRanges([
			readout({ civilDusk: '2026-06-21T01:00:00Z', sunrise: '2026-06-21T10:00:00Z' }),
			readout({ civilDusk: '2026-06-21T01:12:00Z' }),
			readout({ civilDusk: '2026-06-21T00:56:00Z', sunrise: '2026-06-21T10:04:00Z' }),
		]);
		expect(summary.civilDusk?.min.toISOString()).toBe('2026-06-21T00:56:00.000Z');
		expect(summary.civilDusk?.max.toISOString()).toBe('2026-06-21T01:12:00.000Z');
		expect(summary.sunrise?.min.toISOString()).toBe('2026-06-21T10:00:00.000Z');
		expect(summary.sunrise?.max.toISOString()).toBe('2026-06-21T10:04:00.000Z');
		expect(summary.sunset).toBeUndefined();
	});
});
