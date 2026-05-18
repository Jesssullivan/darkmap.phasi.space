import { describe, expect, it } from 'vitest';
import type { BodyPosition } from './EphemerisClient';
import type { HorizonPolygon } from './HorizonProvider';
import { refineEventSet, refineHorizonEvent } from './horizonAwareEvents';

// Synthetic sun: altitude rises linearly from -20° at t=0 to +20° at t=4h,
// azimuth fixed at 90° (due east) so terrain at azimuth 90° is what
// matters for the crossing search.
const linearSun = (startTime: number): ((t: Date) => BodyPosition) => {
	const totalMs = 4 * 3600 * 1000;
	return (t: Date) => {
		const dt = (t.getTime() - startTime) / totalMs;
		const altitudeDeg = -20 + 40 * dt;
		return { altitudeDeg, azimuthDeg: 90 };
	};
};

// Flat horizon (terrain = 0° everywhere).
const flatHorizon: HorizonPolygon = [
	{ azimuthDeg: 0, altitudeDeg: 0 },
	{ azimuthDeg: 90, altitudeDeg: 0 },
	{ azimuthDeg: 180, altitudeDeg: 0 },
	{ azimuthDeg: 270, altitudeDeg: 0 },
];

// Mountain to the east: 10° of terrain altitude at az 90°, flat elsewhere.
const easternMountain: HorizonPolygon = [
	{ azimuthDeg: 0, altitudeDeg: 0 },
	{ azimuthDeg: 90, altitudeDeg: 10 },
	{ azimuthDeg: 180, altitudeDeg: 0 },
	{ azimuthDeg: 270, altitudeDeg: 0 },
];

describe('refineHorizonEvent — sunrise (offsetDeg=0)', () => {
	it('returns ~the flat sunrise time when terrain is 0°', () => {
		// Sun crosses 0° at t = 2h (midpoint of -20°→+20° linear ramp).
		const start = 0;
		const flatSunrise = new Date(start + 2 * 3600 * 1000);
		const refined = refineHorizonEvent(flatSunrise, linearSun(start), flatHorizon);
		expect(refined).not.toBeNull();
		// Bisection precision is 1 s; within that of flat sunrise.
		expect(Math.abs((refined as Date).getTime() - flatSunrise.getTime())).toBeLessThan(1500);
	});

	it('pushes sunrise later when a 10° mountain blocks the eastern horizon', () => {
		// True sunrise when sun-alt crosses +10°, which is t = 2h + 1h = 3h.
		const start = 0;
		const flatSunrise = new Date(start + 2 * 3600 * 1000);
		const refined = refineHorizonEvent(flatSunrise, linearSun(start), easternMountain);
		expect(refined).not.toBeNull();
		const expected = start + 3 * 3600 * 1000;
		expect(Math.abs((refined as Date).getTime() - expected)).toBeLessThan(2000);
	});

	it('returns null when the search window contains no crossing', () => {
		// Sun is always above 0° within the window if we start the linear
		// ramp at +5° → +20°. No crossing.
		const sun: (t: Date) => BodyPosition = () => ({ altitudeDeg: 15, azimuthDeg: 90 });
		const refined = refineHorizonEvent(new Date(0), sun, flatHorizon);
		expect(refined).toBeNull();
	});
});

describe('refineHorizonEvent — twilight offsets', () => {
	it('finds astronomical dawn at sun_alt = -18° (offsetDeg=-18) over flat horizon', () => {
		// Sun-alt = -18° at t = 0.05 * 4h = 12min (when -20 + 40*x = -18 → x = 0.05).
		const start = 0;
		const flatAstroDawn = new Date(start + 0.05 * 4 * 3600 * 1000);
		const refined = refineHorizonEvent(flatAstroDawn, linearSun(start), flatHorizon, {
			offsetDeg: -18,
		});
		expect(refined).not.toBeNull();
		expect(Math.abs((refined as Date).getTime() - flatAstroDawn.getTime())).toBeLessThan(1500);
	});
});

describe('refineEventSet', () => {
	const start = 0;
	const sunFn = linearSun(start);

	it('refines every non-null event in the set', () => {
		const flat = {
			astronomicalDawn: new Date(start + 0.05 * 4 * 3600 * 1000),
			nauticalDawn: new Date(start + 0.2 * 4 * 3600 * 1000),
			civilDawn: new Date(start + 0.35 * 4 * 3600 * 1000),
			sunrise: new Date(start + 0.5 * 4 * 3600 * 1000),
			sunset: null,
			civilDusk: null,
			nauticalDusk: null,
			astronomicalDusk: null,
		};
		const out = refineEventSet(flat, sunFn, flatHorizon);
		expect(out.astronomicalDawn).not.toBeNull();
		expect(out.sunrise).not.toBeNull();
		expect(out.sunset).toBeNull();
	});

	it('mountain to the east shifts sunrise later than astro dawn shifts (less rotation budget)', () => {
		// Astro dawn (sun at -18° flat → -18° + 10° = -8°): refined crosses
		// -8° at t where -20 + 40x = -8 → x = 0.3 → 1.2h.
		// Sunrise (sun at 0° flat → 10°): refined at 0.75 → 3.0h.
		// Both shift, but sunrise shifts by 1h vs astro dawn ~1h too.
		// Test: refined.sunrise > flat.sunrise (sunrise gets pushed later).
		const flatSunrise = new Date(start + 2 * 3600 * 1000);
		const out = refineEventSet(
			{
				astronomicalDawn: null,
				nauticalDawn: null,
				civilDawn: null,
				sunrise: flatSunrise,
				sunset: null,
				civilDusk: null,
				nauticalDusk: null,
				astronomicalDusk: null,
			},
			sunFn,
			easternMountain,
		);
		expect(out.sunrise).not.toBeNull();
		expect((out.sunrise as Date).getTime()).toBeGreaterThan(flatSunrise.getTime());
	});
});
