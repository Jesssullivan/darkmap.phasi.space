import { describe, expect, it } from 'vitest';
import {
	PHASE_COLORS,
	PHASE_DEFINITIONS,
	buildPhaseGradient,
	buildPhaseSegments,
	phaseAt,
	type EphemerisEvents,
	type PhaseName,
} from './twilight-phases';

/* ----------------------------- fixtures ----------------------------- */

const DAY_START = Date.UTC(2026, 4, 27, 0, 0, 0);
const DAY_MS = 24 * 3600 * 1000;
const at = (hours: number): Date => new Date(DAY_START + hours * 3600 * 1000);
const fracOf = (d: Date | null): number | null => {
	if (!d) return null;
	const dt = d.getTime() - DAY_START;
	if (dt < 0 || dt > DAY_MS) return null;
	return dt / DAY_MS;
};

const fullDay: EphemerisEvents = {
	astronomicalDawn: at(3),
	nauticalDawn: at(4),
	civilDawn: at(5),
	sunrise: at(6),
	sunset: at(18),
	civilDusk: at(19),
	nauticalDusk: at(20),
	astronomicalDusk: at(21),
};

const empty: EphemerisEvents = {
	astronomicalDawn: null,
	nauticalDawn: null,
	civilDawn: null,
	sunrise: null,
	sunset: null,
	civilDusk: null,
	nauticalDusk: null,
	astronomicalDusk: null,
};

/* ---------------------------- contract ---------------------------- */

describe('PHASE_DEFINITIONS', () => {
	it('has a definition for every PhaseName', () => {
		const names: PhaseName[] = ['night', 'astronomical-twilight', 'nautical-twilight', 'civil-twilight', 'daylight'];
		for (const n of names) {
			expect(PHASE_DEFINITIONS[n]).toBeDefined();
			expect(PHASE_DEFINITIONS[n].label.length).toBeGreaterThan(0);
			expect(PHASE_DEFINITIONS[n].description.length).toBeGreaterThan(0);
			expect(PHASE_DEFINITIONS[n].altitudeRange.length).toBeGreaterThan(0);
			expect(PHASE_COLORS[n]).toBe(PHASE_DEFINITIONS[n].color);
		}
	});

	it('colors match the prior inlined palette', () => {
		// Pin the prior gradient palette so a stray color rebrand triggers
		// a deliberate review.
		expect(PHASE_DEFINITIONS.night.color).toBe('#06080d');
		expect(PHASE_DEFINITIONS['astronomical-twilight'].color).toBe('#0c1633');
		expect(PHASE_DEFINITIONS['nautical-twilight'].color).toBe('#1f3a73');
		expect(PHASE_DEFINITIONS['civil-twilight'].color).toBe('#d18b3a');
		expect(PHASE_DEFINITIONS.daylight.color).toBe('#7fbbff');
	});
});

/* --------------------------- happy path --------------------------- */

describe('buildPhaseSegments — happy path', () => {
	it('produces 9 contiguous bands covering [0,1] when every event is present', () => {
		const segs = buildPhaseSegments(fullDay, fracOf);
		expect(segs.length).toBe(9);
		expect(segs[0].startFrac).toBe(0);
		expect(segs[segs.length - 1].endFrac).toBe(1);
		for (let i = 1; i < segs.length; i++) {
			expect(segs[i].startFrac).toBe(segs[i - 1].endFrac);
		}
	});

	it('orders phases in dawn → daylight → dusk → night sequence', () => {
		const segs = buildPhaseSegments(fullDay, fracOf);
		const sequence = segs.map((s) => s.name);
		expect(sequence).toEqual([
			'night',
			'astronomical-twilight',
			'nautical-twilight',
			'civil-twilight',
			'daylight',
			'civil-twilight',
			'nautical-twilight',
			'astronomical-twilight',
			'night',
		]);
	});

	it('every segment carries its label, color, and description from the definitions table', () => {
		const segs = buildPhaseSegments(fullDay, fracOf);
		for (const seg of segs) {
			const def = PHASE_DEFINITIONS[seg.name];
			expect(seg.label).toBe(def.label);
			expect(seg.color).toBe(def.color);
			expect(seg.description).toBe(def.description);
			expect(seg.altitudeRange).toBe(def.altitudeRange);
		}
	});
});

/* ------------------------- missing events ------------------------- */

describe('buildPhaseSegments — missing events / polar edge cases', () => {
	it('emits a single night band when no events are available', () => {
		const segs = buildPhaseSegments(empty, fracOf);
		expect(segs.length).toBe(1);
		expect(segs[0].name).toBe('night');
		expect(segs[0].startFrac).toBe(0);
		expect(segs[0].endFrac).toBe(1);
	});

	it('respects `initialPhase: daylight` for polar-day callers', () => {
		const segs = buildPhaseSegments(empty, fracOf, { initialPhase: 'daylight' });
		expect(segs.length).toBe(1);
		expect(segs[0].name).toBe('daylight');
	});

	it('skips a missing astronomicalDawn but resumes at nauticalDawn', () => {
		const partial: EphemerisEvents = {
			...fullDay,
			astronomicalDawn: null,
		};
		const segs = buildPhaseSegments(partial, fracOf);
		// Night band extends from 0 up to nauticalDawn (4h / 24h = 1/6).
		expect(segs[0].name).toBe('night');
		expect(segs[0].endFrac).toBeCloseTo(4 / 24, 6);
		// We never entered astronomical-twilight (no astroDawn event), so
		// the next segment after night is nautical-twilight directly.
		expect(segs[1].name).toBe('nautical-twilight');
	});

	it('drops out-of-day events without panicking', () => {
		const before: EphemerisEvents = {
			...empty,
			sunrise: new Date(DAY_START - 60 * 60 * 1000),
			sunset: new Date(DAY_START + 28 * 60 * 60 * 1000),
		};
		const segs = buildPhaseSegments(before, fracOf);
		// Both events fall outside [0,1] → single night band.
		expect(segs.length).toBe(1);
		expect(segs[0].name).toBe('night');
	});

	it('ignores a regressive event (e.g. clock jump) and continues forward', () => {
		const regressive: EphemerisEvents = {
			...fullDay,
			// nauticalDawn appears *before* astronomicalDawn — this is bogus
			// data; the helper should treat it as missing rather than emit a
			// negative-width band.
			nauticalDawn: at(2),
		};
		const segs = buildPhaseSegments(regressive, fracOf);
		for (let i = 1; i < segs.length; i++) {
			expect(segs[i].startFrac).toBeGreaterThanOrEqual(segs[i - 1].startFrac);
			expect(segs[i].endFrac).toBeGreaterThan(segs[i].startFrac);
		}
	});
});

/* ---------------------------- gradient ---------------------------- */

describe('buildPhaseGradient', () => {
	it('returns a single-color fallback when segments are empty', () => {
		expect(buildPhaseGradient([])).toBe(PHASE_DEFINITIONS.night.color);
	});

	it('produces a CSS gradient with two stops per segment in order', () => {
		const segs = buildPhaseSegments(fullDay, fracOf);
		const grad = buildPhaseGradient(segs);
		expect(grad.startsWith('linear-gradient(to right,')).toBe(true);
		// Each segment contributes one open and one close stop.
		const commas = grad.split(',').length - 1;
		expect(commas).toBe(segs.length * 2 - 1 + 1); // n*2 stops → n*2 - 1 commas inside; plus the 'to right,' comma.
	});
});

/* ----------------------------- phaseAt ----------------------------- */

describe('phaseAt', () => {
	it('returns the segment covering the cursor position', () => {
		const segs = buildPhaseSegments(fullDay, fracOf);
		const noon = 12 / 24;
		expect(phaseAt(segs, noon)?.name).toBe('daylight');

		const earlyMorning = 1 / 24; // 1 UTC — before any twilight event.
		expect(phaseAt(segs, earlyMorning)?.name).toBe('night');

		const evening = 19.5 / 24; // between civil and nautical dusk.
		expect(phaseAt(segs, evening)?.name).toBe('nautical-twilight');
	});

	it('returns undefined when no segments are provided', () => {
		expect(phaseAt([], 0.5)).toBeUndefined();
	});
});
