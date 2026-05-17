import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { EphemerisClient, EphemerisClientLive, type EphemerisReadout, type LatLon } from './EphemerisClient';

const TOLERANCE_MS = 10_000;

const ephemAt = (loc: LatLon, t: Date): EphemerisReadout =>
	Effect.runSync(
		Effect.gen(function* () {
			const c = yield* EphemerisClient;
			return yield* c.at(loc, t);
		}).pipe(Effect.provide(EphemerisClientLive)),
	);

const within = (actual: Date | null, expected: string, ms = TOLERANCE_MS): void => {
	if (!actual) throw new Error(`expected event near ${expected}, got null`);
	const diff = Math.abs(actual.getTime() - new Date(expected).getTime());
	if (diff > ms) {
		throw new Error(`event ${actual.toISOString()} differs from ${expected} by ${diff}ms (>${ms}ms)`);
	}
};

// Reference values captured 2024-12-21 from astronomy-engine 2.1.19, whose
// underlying VSOP87 / lunar ephemeris is independently validated against
// USNO MICA to ~1 arcsec (see github.com/cosinekitty/astronomy). The
// purpose of these fixtures is to detect (a) regression in our wrapper
// code and (b) precision drift on astronomy-engine version bumps.
//
// Spot-checked against timeanddate.com for 2024-12-21:
//   Ottawa  sunrise 07:39 EST / sunset 16:22 EST
//   Quito   sunrise 06:08 / sunset 18:13 (offset for 0°,-78.5° vs city)
//   Reykjavík sunrise 11:22 UTC / sunset 15:29 UTC
const REFERENCE_T = new Date('2024-12-21T12:00:00Z');

describe('EphemerisClient — USNO-reference fixtures (±10s)', () => {
	it('Quito-equator (0°, -78.5°)', () => {
		const r = ephemAt({ lat: 0.0, lon: -78.5 }, REFERENCE_T);
		within(r.events.astronomicalDawn, '2024-12-21T09:53:31.738Z');
		within(r.events.nauticalDawn, '2024-12-21T10:19:52.684Z');
		within(r.events.civilDawn, '2024-12-21T10:46:06.602Z');
		within(r.events.sunrise, '2024-12-21T11:08:38.030Z');
		within(r.events.solarNoon, '2024-12-21T17:12:23.993Z');
		within(r.events.sunset, '2024-12-21T23:16:09.962Z');
		within(r.events.civilDusk, '2024-12-21T23:38:41.374Z');
	});

	it('Ottawa-45N (45.42°, -75.69°)', () => {
		const r = ephemAt({ lat: 45.42, lon: -75.69 }, REFERENCE_T);
		within(r.events.astronomicalDawn, '2024-12-21T10:51:53.590Z');
		within(r.events.nauticalDawn, '2024-12-21T11:27:57.150Z');
		within(r.events.civilDawn, '2024-12-21T12:05:32.594Z');
		within(r.events.sunrise, '2024-12-21T12:39:43.443Z');
		within(r.events.solarNoon, '2024-12-21T17:01:09.360Z');
		within(r.events.sunset, '2024-12-21T21:22:35.573Z');
		within(r.events.civilDusk, '2024-12-21T21:56:46.424Z');
		within(r.events.nauticalDusk, '2024-12-21T22:34:21.908Z');
		within(r.events.astronomicalDusk, '2024-12-21T23:10:25.445Z');
	});

	it('Reykjavík-64N (64.13°, -21.94°) — near-polar winter, all events still present', () => {
		const r = ephemAt({ lat: 64.13, lon: -21.94 }, REFERENCE_T);
		within(r.events.astronomicalDawn, '2024-12-21T07:54:02.724Z');
		within(r.events.nauticalDawn, '2024-12-21T08:54:01.695Z');
		within(r.events.civilDawn, '2024-12-21T10:03:06.281Z');
		within(r.events.sunrise, '2024-12-21T11:22:14.260Z');
		within(r.events.solarNoon, '2024-12-21T13:26:04.909Z');
		within(r.events.sunset, '2024-12-21T15:29:55.825Z');
		within(r.events.civilDusk, '2024-12-21T16:49:03.813Z');
		within(r.events.nauticalDusk, '2024-12-21T17:58:08.415Z');
		within(r.events.astronomicalDusk, '2024-12-21T18:58:07.381Z');
	});
});

describe('EphemerisClient — structural invariants', () => {
	it('twilight events at Ottawa are strictly ordered dawn < sunrise < noon < sunset < dusk', () => {
		const r = ephemAt({ lat: 45.42, lon: -75.69 }, REFERENCE_T);
		const e = r.events;
		const t = (d: Date | null) => (d ? d.getTime() : NaN);
		expect(t(e.astronomicalDawn)).toBeLessThan(t(e.nauticalDawn));
		expect(t(e.nauticalDawn)).toBeLessThan(t(e.civilDawn));
		expect(t(e.civilDawn)).toBeLessThan(t(e.sunrise));
		expect(t(e.sunrise)).toBeLessThan(t(e.solarNoon));
		expect(t(e.solarNoon)).toBeLessThan(t(e.sunset));
		expect(t(e.sunset)).toBeLessThan(t(e.civilDusk));
		expect(t(e.civilDusk)).toBeLessThan(t(e.nauticalDusk));
		expect(t(e.nauticalDusk)).toBeLessThan(t(e.astronomicalDusk));
	});

	it('returns current sun + moon position with bounded altitude/azimuth', () => {
		const r = ephemAt({ lat: 42.4434, lon: -76.5019 }, REFERENCE_T);
		expect(r.sun.altitudeDeg).toBeGreaterThan(-90);
		expect(r.sun.altitudeDeg).toBeLessThan(90);
		expect(r.sun.azimuthDeg).toBeGreaterThanOrEqual(0);
		expect(r.sun.azimuthDeg).toBeLessThan(360);
		expect(r.moon.altitudeDeg).toBeGreaterThan(-90);
		expect(r.moon.altitudeDeg).toBeLessThan(90);
		expect(r.moon.illumination).toBeGreaterThanOrEqual(0);
		expect(r.moon.illumination).toBeLessThanOrEqual(1);
		expect(r.moon.phaseDeg).toBeGreaterThanOrEqual(0);
		expect(r.moon.phaseDeg).toBeLessThan(360);
	});

	it('positionAt returns finite sun + moon altitude/azimuth in valid ranges', () => {
		const out = Effect.runSync(
			Effect.gen(function* () {
				const c = yield* EphemerisClient;
				return yield* c.positionAt({ lat: 45.42, lon: -75.69 }, REFERENCE_T);
			}).pipe(Effect.provide(EphemerisClientLive)),
		);
		expect(Number.isFinite(out.sun.altitudeDeg)).toBe(true);
		expect(out.sun.altitudeDeg).toBeGreaterThan(-90);
		expect(out.sun.altitudeDeg).toBeLessThan(90);
		expect(out.sun.azimuthDeg).toBeGreaterThanOrEqual(0);
		expect(out.sun.azimuthDeg).toBeLessThan(360);
		expect(Number.isFinite(out.moon.altitudeDeg)).toBe(true);
	});

	it('positionAt matches at(...).sun/moon for the same instant', () => {
		const inputs = { loc: { lat: 0, lon: 0 }, t: REFERENCE_T };
		const [full, light] = Effect.runSync(
			Effect.gen(function* () {
				const c = yield* EphemerisClient;
				return [yield* c.at(inputs.loc, inputs.t), yield* c.positionAt(inputs.loc, inputs.t)] as const;
			}).pipe(Effect.provide(EphemerisClientLive)),
		);
		expect(light.sun.altitudeDeg).toBeCloseTo(full.sun.altitudeDeg, 6);
		expect(light.sun.azimuthDeg).toBeCloseTo(full.sun.azimuthDeg, 6);
		expect(light.moon.altitudeDeg).toBeCloseTo(full.moon.altitudeDeg, 6);
		expect(light.moon.azimuthDeg).toBeCloseTo(full.moon.azimuthDeg, 6);
	});

	it('moon phase name matches the phase angle bucket', () => {
		// 2024-12-30T22:27 UTC is the New Moon for this lunation cycle.
		const r = ephemAt({ lat: 0, lon: 0 }, new Date('2024-12-30T22:27:00Z'));
		expect(r.moon.phaseName).toBe('new');

		// 2024-12-15T09:01 UTC is Full Moon.
		const r2 = ephemAt({ lat: 0, lon: 0 }, new Date('2024-12-15T09:01:00Z'));
		expect(r2.moon.phaseName).toBe('full');
	});
});
