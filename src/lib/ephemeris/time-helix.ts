/**
 * Time-helix geometry — the pure math behind the TimeHelix component (the
 * twilight gantt's successor, and the seed of phasi.space's foundational UI).
 *
 * The model: a helical ribbon where the ROTATIONAL dimension is the passage of
 * 24 hours (one revolution) and the AXIS is the passage of time. Polyphasic
 * schedules make no assumption of 24-hour days, so the "day view" is not a
 * hard UTC-day strip (the gantt's core mobile defect — daylight sat mid-strip
 * in the evening) but a 24h Hann window sliding along the helix, always
 * CENTERED on the cursor (default: now). Twilight phases color the ribbon;
 * sun/moon events ride it as nodules (flat in darkmap V1 — the `kind`
 * discriminant leaves room for phasi.space's fractal Monadic schedulables).
 *
 * Everything here is pure + DOM-free (node-safe ephemeris test slice). The
 * component owns rendering; this module owns the contract:
 *   absolute time ──▶ helix coordinates / depth / emphasis / phase color.
 */

import {
	buildPhaseSegments,
	PHASE_DEFINITIONS,
	type EphemerisEvents,
	type PhaseName,
	type TwilightPhaseSegment,
} from './twilight-phases';

/* ───────────────────────────── constants ───────────────────────────── */

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** Visible window: cursor ± 18h = 1.5 revolutions. ±12h would zero the Hann
 * envelope exactly at the strip edges (dead pixels, no procession); ±24h drops
 * below tap-discriminability at 375px. 1.5 revolutions reads as a wave. */
export const SPAN_HOURS = 36;

/** Hann emphasis: full weight at the cursor, floor outside ±12h — the 24h
 * focal window "breathes" around the cursor instead of anchoring to a day. */
export const HANN_HALF_WIDTH_H = 12;
export const HANN_FLOOR = 0.22;

/** Ribbon sampling granularity. 15min ≈ 2.4px at 375px-wide COMPACT — color
 * quantization error ≤7.5min is sub-pixel; the shortest phase (~30min civil
 * twilight) still gets two segments. Finer buys nothing visible, +DOM. */
export const SEGMENT_STEP_MIN = 15;

/* ───────────────────────────── geometry ───────────────────────────── */

export type HelixOrientation = 'horizontal' | 'vertical';

export interface HelixGeometry {
	/** Strip box in px (the measured .bar client box). */
	readonly width: number;
	readonly height: number;
	/** Hours spanned by the strip's axis dimension. */
	readonly spanHours: number;
	/** Axis epoch (ms) — a FIXED reference (mount-day UTC midnight). All axis
	 * coordinates are absolute against it; the component pans via translate. */
	readonly epochMs: number;
	/** Viewport-center longitude, deg — anchors the revolution to LOCAL MEAN
	 * SOLAR time so daylight rides the crest at every longitude. */
	readonly lonDeg: number;
	readonly orientation: HelixOrientation;
}

export interface HelixScales {
	readonly pxPerHour: number;
	/** Sweep amplitude (the visible half-height of the wave). */
	readonly r: number;
	/** Sweep midline (px from the top in horizontal orientation). */
	readonly mid: number;
	/** Base ribbon stroke width before depth modulation. */
	readonly baseStroke: number;
}

/** Derive the pixel scales for a geometry. The axis length is `width` for
 * horizontal and `height` for vertical; the sweep spans the other dimension. */
export const helixScales = (g: HelixGeometry): HelixScales => {
	const axisLen = g.orientation === 'horizontal' ? g.width : g.height;
	const sweepLen = g.orientation === 'horizontal' ? g.height : g.width;
	return {
		pxPerHour: axisLen / g.spanHours,
		r: 0.32 * sweepLen,
		// Slight downward bias leaves headroom for the "now" label above the crest.
		mid: 0.52 * sweepLen,
		baseStroke: sweepLen / 17,
	};
};

/** Local-mean-solar day fraction: 0 = solar midnight, 0.5 = solar noon at
 * `lonDeg`. This is what makes the wave shape itself a clock — daylight is
 * always the crest, night always the trough, at every longitude. */
export const solarDayFrac = (tMs: number, lonDeg: number): number => {
	const days = tMs / DAY_MS + lonDeg / 360;
	return ((days % 1) + 1) % 1;
};

export interface HelixPoint {
	readonly x: number;
	readonly y: number;
	/** Depth, +1 = nearest the viewer. The dusk limb renders near/bright —
	 * darkmap is an evening-planning instrument. */
	readonly z: number;
}

/** Project an absolute time onto the helix (epoch-anchored absolute coords —
 * the component centers the cursor by translating the whole tape). */
export const helixPoint = (tMs: number, g: HelixGeometry, s: HelixScales = helixScales(g)): HelixPoint => {
	const theta = 2 * Math.PI * solarDayFrac(tMs, g.lonDeg);
	const axis = ((tMs - g.epochMs) / HOUR_MS) * s.pxPerHour;
	// SVG y grows downward: +cosθ puts solar midnight (θ=0) at the trough
	// (visually the bottom) and solar noon (θ=π) at the crest.
	const sweep = s.mid + s.r * Math.cos(theta);
	const z = -Math.sin(theta);
	return g.orientation === 'horizontal' ? { x: axis, y: sweep, z } : { x: sweep, y: axis, z };
};

/** Depth-modulated stroke width: far 0.65×, near 1.35×. */
export const depthStroke = (z: number, baseStroke: number): number => baseStroke * (1 + 0.35 * z);

/** Depth-modulated alpha: far 0.55, near 1.0. */
export const depthAlpha = (z: number): number => 0.55 + 0.225 * (z + 1);

/* ─────────────────────────── Hann emphasis ─────────────────────────── */

/** Emphasis weight for an offset from the cursor. w(0)=1, w(±12h)=floor,
 * floor beyond — the 24h focal window, cos²-tapered (a Hann window). */
export const hannWeight = (deltaMs: number): number => {
	const h = Math.abs(deltaMs) / HOUR_MS;
	if (h >= HANN_HALF_WIDTH_H) return HANN_FLOOR;
	const c = Math.cos((Math.PI * h) / (2 * HANN_HALF_WIDTH_H));
	return HANN_FLOOR + (1 - HANN_FLOOR) * c * c;
};

export interface HannStop {
	/** Gradient offset along the strip axis, [0, 1]. */
	readonly offset: number;
	readonly opacity: number;
}

/** The screen-fixed Hann envelope as gradient stops (the cursor is always the
 * strip center, so the envelope never moves — encode it ONCE as an SVG mask
 * and scrubbing only ever translates the tape underneath it). */
export const hannStops = (spanHours: number = SPAN_HOURS, stepH = 3): readonly HannStop[] => {
	const half = spanHours / 2;
	const stops: HannStop[] = [];
	for (let h = -half; h <= half + 1e-9; h += stepH) {
		stops.push({ offset: (h + half) / spanHours, opacity: hannWeight(h * HOUR_MS) });
	}
	return stops;
};

/* ────────────────────── day window + stitching ─────────────────────── */

/** UTC day-start (ms) for a time. */
export const utcDayStart = (tMs: number): number => Math.floor(tMs / DAY_MS) * DAY_MS;

/** The UTC day-starts whose days intersect the visible window (± a margin so
 * partially-visible revolutions render). 1–3 days for the 36h span. */
export const visibleUtcDayStarts = (
	cursorMs: number,
	spanHours: number = SPAN_HOURS,
	marginHours = 1,
): readonly number[] => {
	const half = (spanHours / 2 + marginHours) * HOUR_MS;
	const first = utcDayStart(cursorMs - half);
	const last = utcDayStart(cursorMs + half);
	const out: number[] = [];
	for (let d = first; d <= last; d += DAY_MS) out.push(d);
	return out;
};

/** A phase band in ABSOLUTE time (the per-day [0,1] fracs stitched onto the
 * continuous timeline — the now-centered window always spans a midnight). */
export interface AbsolutePhaseSegment {
	readonly name: PhaseName;
	readonly color: string;
	readonly label: string;
	readonly description: string;
	readonly startMs: number;
	readonly endMs: number;
}

export interface DaySegments {
	readonly dayStartMs: number;
	readonly segments: readonly TwilightPhaseSegment[];
}

/** The seam rule: day k+1's `initialPhase` must equal day k's final phase
 * (feed this to `buildPhaseSegments` via `BuildPhaseOptions.initialPhase`).
 * Without it, polar days flash a fake night at every midnight. */
export const finalPhaseOf = (segments: readonly TwilightPhaseSegment[]): PhaseName =>
	segments.length > 0 ? segments[segments.length - 1].name : 'night';

/**
 * Stitch per-UTC-day segment lists into one contiguous absolute-time list,
 * merging same-phase runs across midnights. Days must be consecutive and
 * sorted; gaps in the day list produce honest gaps in the output (a day whose
 * ephemeris hasn't loaded simply isn't colored — never fabricated).
 */
export const stitchDaySegments = (days: readonly DaySegments[]): readonly AbsolutePhaseSegment[] => {
	const out: AbsolutePhaseSegment[] = [];
	for (const day of days) {
		for (const seg of day.segments) {
			const startMs = day.dayStartMs + seg.startFrac * DAY_MS;
			const endMs = day.dayStartMs + seg.endFrac * DAY_MS;
			const prev = out[out.length - 1];
			if (prev && prev.name === seg.name && Math.abs(prev.endMs - startMs) < 1) {
				// Same phase continues across the boundary — merge the runs.
				out[out.length - 1] = { ...prev, endMs };
			} else {
				out.push({
					name: seg.name,
					color: seg.color,
					label: seg.label,
					description: seg.description,
					startMs,
					endMs,
				});
			}
		}
	}
	return out;
};

/** Phase containing an absolute time, or undefined outside the stitched span. */
export const phaseAtMs = (stitched: readonly AbsolutePhaseSegment[], tMs: number): AbsolutePhaseSegment | undefined =>
	stitched.find((s) => tMs >= s.startMs && tMs <= s.endMs);

/** Convenience: build one day's segments with the seam-correct initial phase.
 * `prevDaySegments` is the previous day's list (undefined for the first day —
 * callers should seed from solar-altitude evidence or accept 'night'). */
export const buildDaySegments = (
	dayStartMs: number,
	events: EphemerisEvents,
	prevDaySegments?: readonly TwilightPhaseSegment[],
): DaySegments => {
	const fracOf = (d: Date | null): number | null => {
		if (!d) return null;
		const f = (d.getTime() - dayStartMs) / DAY_MS;
		return f >= 0 && f <= 1 ? f : null;
	};
	const segments = buildPhaseSegments(events, fracOf, {
		initialPhase: prevDaySegments ? finalPhaseOf(prevDaySegments) : undefined,
	});
	return { dayStartMs, segments };
};

/* ───────────────────────── ribbon segments ─────────────────────────── */

export interface RibbonSegment {
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
	readonly phase: PhaseName;
	readonly color: string;
	readonly strokeWidth: number;
	readonly alpha: number;
	/** Painter's order: back (z<0) renders before front. */
	readonly front: boolean;
}

/**
 * Sample the stitched phases into short stroked segments along the helix for
 * `[fromMs, toMs]` in epoch-anchored absolute coordinates. Times with no
 * stitched coverage (ephemeris not yet loaded) yield `phase:'night'`-shaped
 * neutral placeholders flagged via `color === NEUTRAL_COLOR` — present (the
 * .stripe contract holds pre-data) but visually honest.
 */
export const NEUTRAL_COLOR = 'rgba(255, 255, 255, 0.18)';

export const buildRibbonSegments = (
	stitched: readonly AbsolutePhaseSegment[],
	g: HelixGeometry,
	fromMs: number,
	toMs: number,
	stepMin: number = SEGMENT_STEP_MIN,
): readonly RibbonSegment[] => {
	const s = helixScales(g);
	const stepMs = stepMin * 60_000;
	const out: RibbonSegment[] = [];
	for (let t = fromMs; t < toMs; t += stepMs) {
		const tEnd = Math.min(t + stepMs, toMs);
		const midMs = (t + tEnd) / 2;
		const a = helixPoint(t, g, s);
		const b = helixPoint(tEnd, g, s);
		const zMid = (a.z + b.z) / 2;
		const phase = phaseAtMs(stitched, midMs);
		out.push({
			x1: a.x,
			y1: a.y,
			x2: b.x,
			y2: b.y,
			phase: phase?.name ?? 'night',
			color: phase?.color ?? NEUTRAL_COLOR,
			strokeWidth: depthStroke(zMid, s.baseStroke),
			alpha: depthAlpha(zMid),
			front: zMid >= 0,
		});
	}
	return out;
};

/* ───────────────────────────── nodules ─────────────────────────────── */

export type HelixEventKey =
	| 'astronomicalDawn'
	| 'nauticalDawn'
	| 'civilDawn'
	| 'sunrise'
	| 'solarNoon'
	| 'sunset'
	| 'civilDusk'
	| 'nauticalDusk'
	| 'astronomicalDusk'
	| 'moonrise'
	| 'moonset';

export interface EventTip {
	readonly short: string;
	readonly long: string;
	readonly description: string;
}

/** Popover copy — ported verbatim from the gantt's eventTipFor (+ the lunar
 * pair, which the gantt's events row never surfaced). */
export const EVENT_TIPS: Readonly<Record<HelixEventKey, EventTip>> = {
	astronomicalDawn: {
		short: 'astro',
		long: 'Astronomical dawn',
		description: 'Sun reaches −18° below the horizon. Astronomical twilight begins.',
	},
	nauticalDawn: {
		short: 'naut',
		long: 'Nautical dawn',
		description: 'Sun reaches −12° below the horizon. Horizon visible at sea.',
	},
	civilDawn: {
		short: 'civil',
		long: 'Civil dawn',
		description: 'Sun reaches −6° below the horizon. Outdoor activities without artificial light become possible.',
	},
	sunrise: {
		short: '↑',
		long: 'Sunrise',
		description: 'Sun crosses the horizon. Civil twilight ends, daylight begins.',
	},
	solarNoon: {
		short: 'noon',
		long: 'Solar noon',
		description: 'Sun is at its highest altitude for the day at the viewport center.',
	},
	sunset: {
		short: '↓',
		long: 'Sunset',
		description: 'Sun crosses the horizon. Daylight ends, civil twilight begins.',
	},
	civilDusk: {
		short: 'civil',
		long: 'Civil dusk',
		description: 'Sun reaches −6° below the horizon. Nautical twilight begins.',
	},
	nauticalDusk: {
		short: 'naut',
		long: 'Nautical dusk',
		description: 'Sun reaches −12° below the horizon. Astronomical twilight begins.',
	},
	astronomicalDusk: {
		short: 'astro',
		long: 'Astronomical dusk',
		description: 'Sun reaches −18° below the horizon. Full astronomical darkness begins.',
	},
	moonrise: {
		short: 'moon↑',
		long: 'Moonrise',
		description: 'Moon crosses the local horizon, rising.',
	},
	moonset: {
		short: 'moon↓',
		long: 'Moonset',
		description: 'Moon crosses the local horizon, setting.',
	},
};

/** V1 nodules are flat events; `kind` leaves room for phasi.space's fractal
 * Monadic-schedulable tree without reshaping the model. */
export interface HelixNodule {
	readonly kind: 'solar-event' | 'lunar-event';
	readonly key: HelixEventKey;
	readonly tMs: number;
	readonly tip: EventTip;
	readonly radius: number;
	readonly color: string;
}

const AMBER = '#ffd166';
const MOON = '#dde2ff';
const NOON = 'rgba(255, 255, 255, 0.55)';

/** Importance hierarchy: sunrise/sunset > moon > twilight bounds ≥ noon.
 * Twilight-bound nodules take the color of the phase being ENTERED. */
const noduleSpec = (key: HelixEventKey): { radius: number; color: string; kind: HelixNodule['kind'] } => {
	switch (key) {
		case 'sunrise':
		case 'sunset':
			return { radius: 4.5, color: AMBER, kind: 'solar-event' };
		case 'moonrise':
		case 'moonset':
			return { radius: 3, color: MOON, kind: 'lunar-event' };
		case 'solarNoon':
			return { radius: 2.5, color: NOON, kind: 'solar-event' };
		case 'astronomicalDawn':
			return { radius: 2.5, color: PHASE_DEFINITIONS['astronomical-twilight'].color, kind: 'solar-event' };
		case 'nauticalDawn':
			return { radius: 2.5, color: PHASE_DEFINITIONS['nautical-twilight'].color, kind: 'solar-event' };
		case 'civilDawn':
			return { radius: 2.5, color: PHASE_DEFINITIONS['civil-twilight'].color, kind: 'solar-event' };
		case 'civilDusk':
			return { radius: 2.5, color: PHASE_DEFINITIONS['nautical-twilight'].color, kind: 'solar-event' };
		case 'nauticalDusk':
			return { radius: 2.5, color: PHASE_DEFINITIONS['astronomical-twilight'].color, kind: 'solar-event' };
		case 'astronomicalDusk':
			return { radius: 2.5, color: PHASE_DEFINITIONS.night.color, kind: 'solar-event' };
	}
};

export type DayEvents = Partial<Record<HelixEventKey, Date | null>>;

/** Flatten per-day event tables into nodules within `[fromMs, toMs]`. */
export const buildNodules = (days: readonly DayEvents[], fromMs: number, toMs: number): readonly HelixNodule[] => {
	const out: HelixNodule[] = [];
	for (const day of days) {
		for (const key of Object.keys(EVENT_TIPS) as HelixEventKey[]) {
			const d = day[key];
			if (!d) continue;
			const tMs = d.getTime();
			if (tMs < fromMs || tMs > toMs) continue;
			const spec = noduleSpec(key);
			out.push({ kind: spec.kind, key, tMs, tip: EVENT_TIPS[key], radius: spec.radius, color: spec.color });
		}
	}
	return out.sort((a, b) => a.tMs - b.tMs);
};

/* ─────────────────────────── formatters ────────────────────────────── */

const pad2 = (n: number): string => n.toString().padStart(2, '0');

/** Device-local HH:MM — the helix labels in local time (the gantt's
 * UTC-everywhere labels were part of the mobile confusion). */
export const fmtClockLocal = (d: Date | null): string => (d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '—');

/** UTC HH:MM — the header's UTC affordance + aria announcements. */
export const fmtClockUtc = (d: Date | null): string =>
	d ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : '—';
