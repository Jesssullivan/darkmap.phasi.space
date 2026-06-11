import { describe, expect, it } from 'vitest';
import {
	buildDaySegments,
	buildNodules,
	buildRibbonSegments,
	DAY_MS,
	depthAlpha,
	depthStroke,
	EVENT_TIPS,
	finalPhaseOf,
	fmtClockLocal,
	fmtClockUtc,
	HANN_FLOOR,
	hannStops,
	hannWeight,
	helixPoint,
	helixScales,
	HOUR_MS,
	NEUTRAL_COLOR,
	phaseAtMs,
	solarDayFrac,
	stitchDaySegments,
	utcDayStart,
	visibleUtcDayStarts,
	type EventTip,
	type HelixGeometry,
	type HelixEventKey,
} from './time-helix';
import type { EphemerisEvents } from './twilight-phases';

/** 2026-06-10T00:00:00Z — the canonical test day. */
const DAY = Date.UTC(2026, 5, 10);

const GEOM: HelixGeometry = {
	width: 351,
	height: 60,
	spanHours: 36,
	epochMs: DAY,
	lonDeg: 0,
	orientation: 'horizontal',
};

/** Mid-latitude synthetic day: dawn chain 02..05, dusk chain 19..22 UTC. */
const eventsFor = (dayStartMs: number): EphemerisEvents => ({
	astronomicalDawn: new Date(dayStartMs + 2 * HOUR_MS),
	nauticalDawn: new Date(dayStartMs + 3 * HOUR_MS),
	civilDawn: new Date(dayStartMs + 4 * HOUR_MS),
	sunrise: new Date(dayStartMs + 5 * HOUR_MS),
	sunset: new Date(dayStartMs + 19 * HOUR_MS),
	civilDusk: new Date(dayStartMs + 20 * HOUR_MS),
	nauticalDusk: new Date(dayStartMs + 21 * HOUR_MS),
	astronomicalDusk: new Date(dayStartMs + 22 * HOUR_MS),
});

const NO_EVENTS: EphemerisEvents = {
	astronomicalDawn: null,
	nauticalDawn: null,
	civilDawn: null,
	sunrise: null,
	sunset: null,
	civilDusk: null,
	nauticalDusk: null,
	astronomicalDusk: null,
};

describe('helix projection', () => {
	it('axis is strictly monotonic in time and one revolution spans 24·pxPerHour', () => {
		const s = helixScales(GEOM);
		let prevX = -Infinity;
		for (let h = 0; h <= 48; h += 1) {
			const p = helixPoint(DAY + h * HOUR_MS, GEOM, s);
			expect(p.x).toBeGreaterThan(prevX);
			prevX = p.x;
		}
		const a = helixPoint(DAY, GEOM, s);
		const b = helixPoint(DAY + DAY_MS, GEOM, s);
		expect(b.x - a.x).toBeCloseTo(24 * s.pxPerHour, 6);
	});

	it('sweep is bounded by ±R around the midline and periodic over 24h', () => {
		const s = helixScales(GEOM);
		for (let m = 0; m < 24 * 60; m += 17) {
			const p = helixPoint(DAY + m * 60_000, GEOM, s);
			expect(p.y).toBeGreaterThanOrEqual(s.mid - s.r - 1e-9);
			expect(p.y).toBeLessThanOrEqual(s.mid + s.r + 1e-9);
		}
		const t = DAY + 7.3 * HOUR_MS;
		expect(helixPoint(t, GEOM, s).y).toBeCloseTo(helixPoint(t + DAY_MS, GEOM, s).y, 9);
		expect(helixPoint(t, GEOM, s).z).toBeCloseTo(helixPoint(t + DAY_MS, GEOM, s).z, 9);
	});

	it('anchors the revolution to local mean solar time (daylight rides the crest)', () => {
		const s = helixScales(GEOM);
		// lon=0: solar midnight (00:00 UTC) sits at the trough (SVG bottom),
		// solar noon (12:00 UTC) at the crest (SVG top — y grows downward).
		expect(solarDayFrac(DAY, 0)).toBeCloseTo(0, 9);
		expect(helixPoint(DAY, GEOM, s).y).toBeCloseTo(s.mid + s.r, 6);
		expect(helixPoint(DAY + 12 * HOUR_MS, GEOM, s).y).toBeCloseTo(s.mid - s.r, 6);
		// lon=180°: the solar day is shifted by half a UTC day.
		expect(solarDayFrac(DAY, 180)).toBeCloseTo(0.5, 9);
	});

	it('the dusk limb is near the viewer, the dawn limb far', () => {
		// Solar 18:00 (u=0.75) → z=+1 (near/bright — the evening instrument);
		// solar 06:00 (u=0.25) → z=−1 (far/dim).
		expect(helixPoint(DAY + 18 * HOUR_MS, GEOM).z).toBeCloseTo(1, 9);
		expect(helixPoint(DAY + 6 * HOUR_MS, GEOM).z).toBeCloseTo(-1, 9);
	});

	it('vertical orientation maps the axis to y and the sweep to x', () => {
		const vert: HelixGeometry = { ...GEOM, width: 60, height: 351, orientation: 'vertical' };
		const s = helixScales(vert);
		expect(s.pxPerHour).toBeCloseTo(351 / 36, 9);
		const a = helixPoint(DAY, vert, s);
		const b = helixPoint(DAY + DAY_MS, vert, s);
		expect(b.y - a.y).toBeCloseTo(24 * s.pxPerHour, 6);
		expect(a.x).toBeCloseTo(s.mid + s.r, 6); // sweep on x
	});

	it('depth modulation: far thin/dim, near thick/bright', () => {
		expect(depthStroke(-1, 10)).toBeCloseTo(6.5, 9);
		expect(depthStroke(1, 10)).toBeCloseTo(13.5, 9);
		expect(depthAlpha(-1)).toBeCloseTo(0.55, 9);
		expect(depthAlpha(1)).toBeCloseTo(1.0, 9);
	});
});

describe('Hann emphasis window', () => {
	it('peaks at the cursor, floors at ±12h, symmetric and monotone', () => {
		expect(hannWeight(0)).toBeCloseTo(1, 9);
		expect(hannWeight(12 * HOUR_MS)).toBeCloseTo(HANN_FLOOR, 9);
		expect(hannWeight(-12 * HOUR_MS)).toBeCloseTo(HANN_FLOOR, 9);
		expect(hannWeight(18 * HOUR_MS)).toBeCloseTo(HANN_FLOOR, 9);
		let prev = hannWeight(0);
		for (let h = 1; h <= 12; h++) {
			const w = hannWeight(h * HOUR_MS);
			expect(w).toBeLessThan(prev);
			expect(w).toBeCloseTo(hannWeight(-h * HOUR_MS), 9);
			prev = w;
		}
	});

	it('emits gradient stops spanning [0,1] with the peak at the strip center', () => {
		const stops = hannStops(36, 3);
		expect(stops[0].offset).toBeCloseTo(0, 9);
		expect(stops[stops.length - 1].offset).toBeCloseTo(1, 9);
		const center = stops.find((s) => Math.abs(s.offset - 0.5) < 1e-9);
		expect(center?.opacity).toBeCloseTo(1, 9);
		expect(stops[0].opacity).toBeCloseTo(HANN_FLOOR, 9);
	});
});

describe('day window + stitching (the now-centered window always spans a midnight)', () => {
	it('visibleUtcDayStarts covers the ±19h window with consecutive days', () => {
		const days = visibleUtcDayStarts(DAY + 12 * HOUR_MS); // mid-day cursor
		expect(days.length).toBeGreaterThanOrEqual(2);
		expect(days.length).toBeLessThanOrEqual(3);
		for (let i = 1; i < days.length; i++) expect(days[i] - days[i - 1]).toBe(DAY_MS);
		expect(days[0]).toBeLessThanOrEqual(utcDayStart(DAY + 12 * HOUR_MS - 19 * HOUR_MS));
	});

	it('the seam invariant: day k+1 opens in day k’s final phase, and same-phase runs merge', () => {
		const day1 = buildDaySegments(DAY, eventsFor(DAY));
		expect(finalPhaseOf(day1.segments)).toBe('night');
		const day2 = buildDaySegments(DAY + DAY_MS, eventsFor(DAY + DAY_MS), day1.segments);
		expect(day2.segments[0].name).toBe('night');

		const stitched = stitchDaySegments([day1, day2]);
		// Contiguity: every boundary is exact.
		for (let i = 1; i < stitched.length; i++) {
			expect(stitched[i].startMs).toBeCloseTo(stitched[i - 1].endMs, 6);
		}
		// The 22:00→02:00 night straddling midnight is ONE merged run.
		const midnightNight = phaseAtMs(stitched, DAY + DAY_MS);
		expect(midnightNight?.name).toBe('night');
		expect(midnightNight?.startMs).toBeCloseTo(DAY + 22 * HOUR_MS, 6);
		expect(midnightNight?.endMs).toBeCloseTo(DAY + DAY_MS + 2 * HOUR_MS, 6);
	});

	it('polar days: an all-daylight revolution stays daylight across the seam (no fake night flash)', () => {
		// A day whose sun rises and never sets ends in daylight…
		const day1 = buildDaySegments(DAY, { ...NO_EVENTS, sunrise: new Date(DAY + 1 * HOUR_MS) });
		expect(finalPhaseOf(day1.segments)).toBe('daylight');
		// …so the next, event-free day (polar summer) is ONE daylight segment.
		const day2 = buildDaySegments(DAY + DAY_MS, NO_EVENTS, day1.segments);
		expect(day2.segments).toHaveLength(1);
		expect(day2.segments[0].name).toBe('daylight');

		const stitched = stitchDaySegments([day1, day2]);
		expect(phaseAtMs(stitched, DAY + DAY_MS)?.name).toBe('daylight');
	});

	it('polar nights: an event-free day with no predecessor defaults to a single night segment', () => {
		const day = buildDaySegments(DAY, NO_EVENTS);
		expect(day.segments).toHaveLength(1);
		expect(day.segments[0].name).toBe('night');
	});
});

describe('ribbon segments', () => {
	it('samples the window into step-sized strokes partitioned front/back', () => {
		const day1 = buildDaySegments(DAY, eventsFor(DAY));
		const stitched = stitchDaySegments([day1]);
		const from = DAY + 6 * HOUR_MS;
		const to = DAY + 18 * HOUR_MS;
		const ribbon = buildRibbonSegments(stitched, GEOM, from, to);
		expect(ribbon).toHaveLength((12 * 60) / 15);
		// Colors map to the stitched phase at the midpoint.
		const noonSeg = ribbon[ribbon.length / 2];
		expect(noonSeg.phase).toBe('daylight');
		// Both halves of the revolution appear.
		expect(ribbon.some((r) => r.front)).toBe(true);
		expect(ribbon.some((r) => !r.front)).toBe(true);
	});

	it('renders honest neutral placeholders where no day data is stitched', () => {
		const ribbon = buildRibbonSegments([], GEOM, DAY, DAY + 2 * HOUR_MS);
		expect(ribbon.length).toBeGreaterThan(0);
		expect(ribbon.every((r) => r.color === NEUTRAL_COLOR)).toBe(true);
	});
});

describe('nodules + copy', () => {
	it('EVENT_TIPS covers every helix event key with non-empty copy', () => {
		const keys = Object.keys(EVENT_TIPS) as HelixEventKey[];
		expect(keys).toHaveLength(11);
		for (const k of keys) {
			const tip: EventTip = EVENT_TIPS[k];
			expect(tip.long.length).toBeGreaterThan(2);
			expect(tip.description.length).toBeGreaterThan(10);
		}
	});

	it('builds windowed, sorted nodules with the importance hierarchy', () => {
		const ev = eventsFor(DAY);
		const days = [
			{
				...ev,
				solarNoon: new Date(DAY + 12 * HOUR_MS),
				moonrise: new Date(DAY + 15 * HOUR_MS),
				moonset: new Date(DAY + 4.5 * HOUR_MS),
			},
		];
		const nodules = buildNodules(days, DAY + 3.5 * HOUR_MS, DAY + 20.5 * HOUR_MS);
		// Window excludes 02:00/03:00 dawn chain + 21:00/22:00 dusk chain.
		expect(nodules.map((n) => n.key)).toEqual([
			'civilDawn',
			'moonset',
			'sunrise',
			'solarNoon',
			'moonrise',
			'sunset',
			'civilDusk',
		]);
		const sunrise = nodules.find((n) => n.key === 'sunrise');
		const bound = nodules.find((n) => n.key === 'civilDawn');
		const moon = nodules.find((n) => n.key === 'moonrise');
		expect(sunrise!.radius).toBeGreaterThan(moon!.radius);
		expect(moon!.radius).toBeGreaterThan(bound!.radius);
		expect(moon!.kind).toBe('lunar-event');
	});
});

describe('formatters', () => {
	it('fmtClockUtc is UTC-exact; fmtClockLocal renders the device-local wall clock', () => {
		const d = new Date(Date.UTC(2026, 5, 10, 21, 7));
		expect(fmtClockUtc(d)).toBe('21:07');
		expect(fmtClockLocal(d)).toMatch(/^\d{2}:\d{2}$/);
		expect(fmtClockUtc(null)).toBe('—');
		expect(fmtClockLocal(null)).toBe('—');
	});
});
