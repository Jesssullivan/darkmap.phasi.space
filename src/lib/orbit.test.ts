import { describe, expect, it } from 'vitest';
import {
	dopplerShiftHz,
	epochAgeDays,
	findPasses,
	lookAngleAt,
	parseTle,
	parseTleSets,
	tleEpoch,
	type Observer,
} from './orbit';
import type { HorizonPolygon } from './ephemeris/horizonAtAzimuth';

// A real published ISS (ZARYA) TLE, epoch 2020-060.85 (1 Mar 2020).
const L1 = '1 25544U 98067A   20060.85138889  .00000737  00000-0  21434-4 0  9996';
const L2 = '2 25544  51.6432  21.4250 0005140  30.2069  84.7649 15.49180547215146';
const ITHACA: Observer = { latitudeDeg: 42.4434, longitudeDeg: -76.5019 };
const START = new Date('2020-03-01T21:00:00Z'); // just after the TLE epoch
const WINDOW_H = 48;

describe('tleEpoch / parseTle', () => {
	it('decodes the line-1 epoch (2-digit year + fractional day-of-year)', () => {
		const e = tleEpoch(L1);
		// Day-of-year 60.85 in leap-year 2020 = Feb 29 (Jan 31 + Feb 29 = 60).
		expect(e.getUTCFullYear()).toBe(2020);
		expect(e.getUTCMonth()).toBe(1); // February (0-indexed)
		expect(e.getUTCDate()).toBe(29);
	});
	it('parseTle yields a usable satrec + epoch', () => {
		const { satrec, epoch } = parseTle(L1, L2, 'ISS');
		expect(satrec.error).toBe(0);
		expect(epoch.getUTCFullYear()).toBe(2020);
	});
});

describe('parseTleSets', () => {
	it('parses a 3-line named record', () => {
		const sets = parseTleSets(`ISS (ZARYA)\n${L1}\n${L2}\n`);
		expect(sets).toHaveLength(1);
		expect(sets[0].name).toBe('ISS (ZARYA)');
		expect(sets[0].line1).toBe(L1);
		expect(sets[0].line2).toBe(L2);
	});
	it('parses multiple sets + tolerates blank lines / CRLF / a 2-line record', () => {
		const sets = parseTleSets(`SAT A\r\n${L1}\r\n${L2}\r\n\r\n${L1}\r\n${L2}\r\n`);
		expect(sets).toHaveLength(2);
		expect(sets[0].name).toBe('SAT A');
		expect(sets[1].name).toBeUndefined(); // 2-line record (no name line)
	});
	it('returns nothing for junk', () => {
		expect(parseTleSets('not a tle\njust text')).toEqual([]);
	});
});

describe('epochAgeDays', () => {
	it('measures now − epoch in days and flags drift', () => {
		const epoch = tleEpoch(L1);
		const age = epochAgeDays(epoch, new Date(epoch.getTime() + 3 * 86_400_000));
		expect(age).toBeCloseTo(3, 6);
	});
});

describe('lookAngleAt', () => {
	it('returns a well-formed az/el/range', () => {
		const { satrec } = parseTle(L1, L2);
		const look = lookAngleAt(satrec, ITHACA, START);
		expect(look).not.toBeNull();
		expect(look!.azDeg).toBeGreaterThanOrEqual(0);
		expect(look!.azDeg).toBeLessThan(360);
		expect(look!.elDeg).toBeGreaterThanOrEqual(-90);
		expect(look!.elDeg).toBeLessThanOrEqual(90);
		expect(look!.rangeKm).toBeGreaterThan(300); // LEO is always >300 km slant
	});
});

describe('findPasses (flat horizon)', () => {
	const { satrec } = parseTle(L1, L2);
	const passes = findPasses({ satrec, observer: ITHACA, start: START, windowHours: WINDOW_H, stepSec: 30 });

	it('finds at least one pass of the ISS over a mid-latitude site in 48 h', () => {
		expect(passes.length).toBeGreaterThan(0);
	});
	it('each pass is well-ordered: AOS ≤ culmination ≤ LOS, positive duration, non-empty track', () => {
		for (const p of passes) {
			expect(p.aos.getTime()).toBeLessThanOrEqual(p.culmination.getTime());
			expect(p.culmination.getTime()).toBeLessThanOrEqual(p.los.getTime());
			expect(p.durationSec).toBeGreaterThan(0);
			expect(p.track.length).toBeGreaterThan(0);
			expect(p.maxElevationDeg).toBeGreaterThan(0);
			expect(p.terrainGated).toBe(false); // flat horizon ⇒ not terrain-gated
		}
	});
});

describe('findPasses — DEM-horizon gating (the differentiator)', () => {
	const { satrec } = parseTle(L1, L2);
	const flat = findPasses({ satrec, observer: ITHACA, start: START, windowHours: WINDOW_H, stepSec: 30 });
	// A 25°-everywhere ridge: only well-overhead passes clear it.
	const ridge: HorizonPolygon = [
		{ azimuthDeg: 0, altitudeDeg: 25 },
		{ azimuthDeg: 90, altitudeDeg: 25 },
		{ azimuthDeg: 180, altitudeDeg: 25 },
		{ azimuthDeg: 270, altitudeDeg: 25 },
	];
	const gated = findPasses({
		satrec,
		observer: ITHACA,
		start: START,
		windowHours: WINDOW_H,
		stepSec: 30,
		horizon: ridge,
	});

	it('a terrain ridge removes low passes (never adds any)', () => {
		expect(gated.length).toBeLessThanOrEqual(flat.length);
	});
	it('every surviving pass clears the ridge and is flagged terrain-gated', () => {
		for (const p of gated) {
			expect(p.terrainGated).toBe(true);
			for (const s of p.track) expect(s.elDeg).toBeGreaterThan(25);
		}
	});
});

describe('dopplerShiftHz', () => {
	it('is positive while approaching (AOS) and negative while receding (LOS)', () => {
		const { satrec } = parseTle(L1, L2);
		const carrierHz = 437_000_000; // 70 cm
		const passes = findPasses({
			satrec,
			observer: ITHACA,
			start: START,
			windowHours: WINDOW_H,
			stepSec: 30,
			carrierHz,
		});
		// Use the highest-culmination pass (cleanest geometry for the sign test).
		const best = passes.reduce((a, b) => (b.maxElevationDeg > a.maxElevationDeg ? b : a));
		expect(best.track[0].dopplerHz).toBeGreaterThan(0);
		expect(best.track[best.track.length - 1].dopplerHz).toBeLessThan(0);
	});

	it('direct call returns a finite shift', () => {
		const { satrec } = parseTle(L1, L2);
		const d = dopplerShiftHz(satrec, ITHACA, START, 437_000_000);
		expect(d).not.toBeNull();
		expect(Number.isFinite(d as number)).toBe(true);
	});
});
