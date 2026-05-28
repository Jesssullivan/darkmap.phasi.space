/**
 * Twilight-phase segmentation for the bottom ephemeris rail (#197).
 *
 * The Gantt strip previously hard-coded its color stops inside the
 * component, which made it hard to attach Skeleton popovers, screen
 * reader labels, and tests. This module owns the *contract* between
 * "ordered ephemeris event times" and "ordered phase bands that cover
 * the UTC day".
 *
 * The helper is data-driven: callers pass an `EphemerisEvents`
 * snapshot (any subset of dawn/sunrise/noon/sunset/dusk events) and a
 * `fracOf(date)` mapper, and receive a contiguous list of phase
 * segments covering `[0, 1]`. Each segment knows its color, label,
 * description, and accessibility name so the UI cannot drift from the
 * docs.
 */

export type PhaseName = 'night' | 'astronomical-twilight' | 'nautical-twilight' | 'civil-twilight' | 'daylight';

export interface PhaseDefinition {
	readonly name: PhaseName;
	readonly label: string;
	readonly color: string;
	/** One-line plain-English description for popover content. */
	readonly description: string;
	/** Solar altitude range in degrees, narrative form. */
	readonly altitudeRange: string;
}

/**
 * Canonical phase table. Colors mirror the Photographer's Ephemeris
 * palette previously inlined in `EphemerisGantt.svelte` so the visual
 * appearance does not change.
 */
export const PHASE_DEFINITIONS: Readonly<Record<PhaseName, PhaseDefinition>> = {
	night: {
		name: 'night',
		label: 'Night',
		color: '#06080d',
		description: 'Sun is more than 18° below the horizon — astronomical darkness.',
		altitudeRange: 'sun < −18°',
	},
	'astronomical-twilight': {
		name: 'astronomical-twilight',
		label: 'Astronomical twilight',
		color: '#0c1633',
		description: 'Sun is 12°–18° below the horizon — faint sky glow begins; best for deep-sky imaging cutoff.',
		altitudeRange: '−18° ≤ sun < −12°',
	},
	'nautical-twilight': {
		name: 'nautical-twilight',
		label: 'Nautical twilight',
		color: '#1f3a73',
		description:
			'Sun is 6°–12° below the horizon — horizon visible at sea, brighter stars still useful for navigation.',
		altitudeRange: '−12° ≤ sun < −6°',
	},
	'civil-twilight': {
		name: 'civil-twilight',
		label: 'Civil twilight',
		color: '#d18b3a',
		description: 'Sun is 0°–6° below the horizon — outdoor activities possible without artificial light.',
		altitudeRange: '−6° ≤ sun < 0°',
	},
	daylight: {
		name: 'daylight',
		label: 'Daylight',
		color: '#7fbbff',
		description: 'Sun is above the horizon.',
		altitudeRange: 'sun ≥ 0°',
	},
};

/** Map from each phase name to its color, used by the gradient builder. */
export const PHASE_COLORS: Readonly<Record<PhaseName, string>> = Object.freeze({
	night: PHASE_DEFINITIONS.night.color,
	'astronomical-twilight': PHASE_DEFINITIONS['astronomical-twilight'].color,
	'nautical-twilight': PHASE_DEFINITIONS['nautical-twilight'].color,
	'civil-twilight': PHASE_DEFINITIONS['civil-twilight'].color,
	daylight: PHASE_DEFINITIONS.daylight.color,
});

/**
 * Subset of the `EphemerisReadout.events` shape that we actually need.
 * Inlined as a structural type so this module has no runtime import
 * cycle with the ephemeris client.
 */
export interface EphemerisEvents {
	readonly astronomicalDawn: Date | null;
	readonly nauticalDawn: Date | null;
	readonly civilDawn: Date | null;
	readonly sunrise: Date | null;
	readonly sunset: Date | null;
	readonly civilDusk: Date | null;
	readonly nauticalDusk: Date | null;
	readonly astronomicalDusk: Date | null;
}

/** Discriminated event-key alphabet local to this module's state machine. */
type PhaseTransitionEventKey =
	| 'astronomicalDawn'
	| 'nauticalDawn'
	| 'civilDawn'
	| 'sunrise'
	| 'sunset'
	| 'civilDusk'
	| 'nauticalDusk'
	| 'astronomicalDusk';

interface Transition {
	readonly event: PhaseTransitionEventKey;
	readonly leaves: PhaseName;
	readonly enters: PhaseName;
}

/**
 * Order of phase transitions across a UTC day. The state machine walks
 * this sequence: at each event the current phase ends and the next one
 * begins. Missing events (polar conditions, sub-day rounding) skip
 * silently and the surrounding phase continues.
 */
const TRANSITIONS: readonly Transition[] = [
	{ event: 'astronomicalDawn', leaves: 'night', enters: 'astronomical-twilight' },
	{ event: 'nauticalDawn', leaves: 'astronomical-twilight', enters: 'nautical-twilight' },
	{ event: 'civilDawn', leaves: 'nautical-twilight', enters: 'civil-twilight' },
	{ event: 'sunrise', leaves: 'civil-twilight', enters: 'daylight' },
	{ event: 'sunset', leaves: 'daylight', enters: 'civil-twilight' },
	{ event: 'civilDusk', leaves: 'civil-twilight', enters: 'nautical-twilight' },
	{ event: 'nauticalDusk', leaves: 'nautical-twilight', enters: 'astronomical-twilight' },
	{ event: 'astronomicalDusk', leaves: 'astronomical-twilight', enters: 'night' },
];

export interface TwilightPhaseSegment {
	readonly name: PhaseName;
	readonly startFrac: number;
	readonly endFrac: number;
	readonly label: string;
	readonly color: string;
	readonly description: string;
	readonly altitudeRange: string;
}

export interface BuildPhaseOptions {
	/**
	 * Phase to assume at frac=0 (UTC midnight). Defaults to `'night'`
	 * which matches the Photographer's Ephemeris convention. Callers
	 * with polar-day evidence (sun never sets) should pass `'daylight'`.
	 */
	readonly initialPhase?: PhaseName;
}

/**
 * Build a contiguous list of phase segments covering `[0, 1]`.
 *
 * Invariants:
 *   - The first segment starts at exactly `0`.
 *   - The last segment ends at exactly `1`.
 *   - Adjacent segments share an exact `endFrac === nextStartFrac` boundary.
 *   - Segments with `startFrac === endFrac` are filtered out (zero-width
 *     bands would produce no visual band, no popover hitbox, and no
 *     useful screen-reader output).
 *   - Event order is enforced: if `fracOf` returns a value that would
 *     move the cursor backward, the transition is treated as missing.
 */
export const buildPhaseSegments = (
	events: EphemerisEvents,
	fracOf: (d: Date | null) => number | null,
	options: BuildPhaseOptions = {},
): readonly TwilightPhaseSegment[] => {
	let currentPhase: PhaseName = options.initialPhase ?? 'night';
	let cursor = 0;

	const out: TwilightPhaseSegment[] = [];
	const flushUntil = (frac: number, phase: PhaseName): void => {
		if (frac <= cursor) return;
		const def = PHASE_DEFINITIONS[phase];
		out.push({
			name: phase,
			startFrac: cursor,
			endFrac: frac,
			label: def.label,
			color: def.color,
			description: def.description,
			altitudeRange: def.altitudeRange,
		});
		cursor = frac;
	};

	for (const t of TRANSITIONS) {
		const f = fracOf(events[t.event]);
		if (f === null) continue;
		if (f < cursor || f > 1) continue;
		flushUntil(f, currentPhase);
		currentPhase = t.enters;
	}

	flushUntil(1, currentPhase);
	return out;
};

/**
 * Build a CSS `linear-gradient(...)` string equivalent to the segment
 * list. Kept here (rather than in the Svelte component) so the gradient
 * is regression-testable against the segment contract.
 */
export const buildPhaseGradient = (segments: readonly TwilightPhaseSegment[]): string => {
	if (segments.length === 0) return PHASE_DEFINITIONS.night.color;
	const stops: string[] = [];
	for (const seg of segments) {
		stops.push(`${seg.color} ${(seg.startFrac * 100).toFixed(2)}%`);
		stops.push(`${seg.color} ${(seg.endFrac * 100).toFixed(2)}%`);
	}
	return `linear-gradient(to right, ${stops.join(', ')})`;
};

/**
 * Locate the phase segment that contains `frac` (the cursor position).
 * Returns `undefined` when `segments` is empty.
 */
export const phaseAt = (segments: readonly TwilightPhaseSegment[], frac: number): TwilightPhaseSegment | undefined => {
	for (const seg of segments) {
		if (frac >= seg.startFrac && frac <= seg.endFrac) return seg;
	}
	return segments[segments.length - 1];
};
