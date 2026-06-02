import { describe, expect, it } from 'vitest';
import {
	airmass,
	clearSkyTransmittance,
	dopplerShiftHz,
	EARTH_RADIUS_KM,
	epochAgeDays,
	findPasses,
	footprintRadiusKm,
	geodesicRing,
	isKeyholePass,
	lookAngleAt,
	maxAzSlewRateDegPerSec,
	parseTle,
	parseTleSets,
	slantTransmittance,
	subSatellitePoint,
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

describe('airmass (Kasten–Young)', () => {
	it('is ≈1 at the zenith and ≈2 at 30°', () => {
		expect(airmass(90)).toBeCloseTo(1, 1);
		expect(airmass(30)).toBeCloseTo(2, 1);
	});
	it('increases monotonically as elevation drops and stays finite to/below the horizon', () => {
		expect(airmass(90)).toBeLessThan(airmass(60));
		expect(airmass(60)).toBeLessThan(airmass(30));
		expect(airmass(30)).toBeLessThan(airmass(10));
		expect(airmass(10)).toBeLessThan(airmass(0.1));
		expect(Number.isFinite(airmass(0))).toBe(true);
		expect(Number.isFinite(airmass(-5))).toBe(true);
	});
});

describe('transmittance estimates', () => {
	it('clear-sky T is higher at high elevation and within (0,1]', () => {
		const hi = clearSkyTransmittance(90);
		const lo = clearSkyTransmittance(10);
		expect(hi).toBeGreaterThan(lo);
		expect(hi).toBeLessThanOrEqual(1);
		expect(lo).toBeGreaterThan(0);
	});
	it('slantTransmittance ≈ zenith T near zenith and drops toward the horizon', () => {
		expect(slantTransmittance(0.9, 90)).toBeCloseTo(0.9, 1);
		expect(slantTransmittance(0.9, 10)).toBeLessThan(0.9);
		expect(slantTransmittance(0.9, 10)).toBeGreaterThan(0);
		expect(slantTransmittance(1, 30)).toBe(1); // a transparent zenith stays transparent at any airmass
	});
});

describe('isKeyholePass + Pass.keyhole', () => {
	it('flags near-zenith culmination at/above the 85° threshold', () => {
		expect(isKeyholePass(88)).toBe(true);
		expect(isKeyholePass(85)).toBe(true);
		expect(isKeyholePass(70)).toBe(false);
	});
	it('findPasses stamps pass.keyhole consistent with the culmination elevation', () => {
		const { satrec } = parseTle(L1, L2);
		const passes = findPasses({ satrec, observer: ITHACA, start: START, windowHours: WINDOW_H, stepSec: 30 });
		for (const p of passes) expect(p.keyhole).toBe(isKeyholePass(p.maxElevationDeg));
	});
});

describe('maxAzSlewRateDegPerSec', () => {
	// Build a synthetic track: az[] sampled every `stepSec` from t=0.
	const mk = (azDeg: number[], stepSec = 30) =>
		azDeg.map((az, i) => ({ t: new Date(i * stepSec * 1000), azDeg: az, elDeg: 45, rangeKm: 600, horizonDeg: 0 }));

	it('returns 0 for <2 samples', () => {
		expect(maxAzSlewRateDegPerSec([])).toBe(0);
		expect(maxAzSlewRateDegPerSec(mk([90]))).toBe(0);
	});
	it('is the worst |Δaz|/Δt across adjacent samples', () => {
		// Δaz 20 then 30 over 30 s steps → peak 30/30 = 1.0 deg/s.
		expect(maxAzSlewRateDegPerSec(mk([10, 30, 60]))).toBeCloseTo(1.0, 6);
	});
	it('takes the short way around the 0/360 wrap (359→1 is 2°, not 358°)', () => {
		expect(maxAzSlewRateDegPerSec(mk([359, 1], 1))).toBeCloseTo(2.0, 6);
	});
	it('spikes for a near-zenith azimuth flip vs a low slow pass', () => {
		const overhead = maxAzSlewRateDegPerSec(mk([80, 260], 30)); // ~180° flip / 30 s = 6 deg/s
		const lowSlow = maxAzSlewRateDegPerSec(mk([80, 100], 30)); // 20° / 30 s ≈ 0.67 deg/s
		expect(overhead).toBeGreaterThan(lowSlow);
		expect(overhead).toBeCloseTo(6.0, 6);
	});
});

describe('Pass.azSlewPeakDegPerSec', () => {
	it('findPasses stamps each pass with its track peak az slew rate (≥ 0, matches the helper)', () => {
		const { satrec } = parseTle(L1, L2);
		const passes = findPasses({ satrec, observer: ITHACA, start: START, windowHours: WINDOW_H, stepSec: 30 });
		for (const p of passes) {
			expect(p.azSlewPeakDegPerSec).toBeGreaterThanOrEqual(0);
			expect(p.azSlewPeakDegPerSec).toBeCloseTo(maxAzSlewRateDegPerSec(p.track), 6);
		}
	});
});

describe('footprintRadiusKm', () => {
	it('is 0 at the surface and grows with altitude', () => {
		expect(footprintRadiusKm(0)).toBeCloseTo(0, 6);
		expect(footprintRadiusKm(800)).toBeGreaterThan(footprintRadiusKm(400));
	});
	it('≈2250 km for the ISS at ~420 km', () => {
		expect(footprintRadiusKm(420)).toBeGreaterThan(2000);
		expect(footprintRadiusKm(420)).toBeLessThan(2500);
	});
});

describe('geodesicRing', () => {
	// Haversine surface distance (km) for the radius check.
	const haversineKm = (aLat: number, aLon: number, bLat: number, bLon: number) => {
		const r = Math.PI / 180;
		const dLat = (bLat - aLat) * r;
		const dLon = (bLon - aLon) * r;
		const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
		return EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(s));
	};
	it('returns points+1 vertices and is closed (first === last)', () => {
		const ring = geodesicRing(42, -76, 1000, 32);
		expect(ring).toHaveLength(33);
		expect(ring[0][0]).toBeCloseTo(ring[32][0], 6);
		expect(ring[0][1]).toBeCloseTo(ring[32][1], 6);
	});
	it('every vertex sits ~radiusKm from the center (geodesic)', () => {
		const ring = geodesicRing(42, -76, 1500, 24);
		for (const [lon, lat] of ring) {
			expect(haversineKm(42, -76, lat, lon)).toBeCloseTo(1500, 0); // within ~1 km
			expect(lon).toBeGreaterThanOrEqual(-180);
			expect(lon).toBeLessThan(180);
		}
	});
});

describe('subSatellitePoint', () => {
	it('returns a plausible geodetic point + LEO altitude for the ISS', () => {
		const { satrec } = parseTle(L1, L2);
		const sub = subSatellitePoint(satrec, START);
		expect(sub).not.toBeNull();
		expect(Math.abs(sub!.latDeg)).toBeLessThanOrEqual(52); // ISS inclination 51.6°
		expect(sub!.lonDeg).toBeGreaterThanOrEqual(-180);
		expect(sub!.lonDeg).toBeLessThan(180);
		expect(sub!.altitudeKm).toBeGreaterThan(300);
		expect(sub!.altitudeKm).toBeLessThan(500);
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
