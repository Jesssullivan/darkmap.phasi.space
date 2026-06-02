// Per-lens PointReadout relevance — the single source of truth for which readout
// sections a lens LEADS with, supports, or sorts into the "more" tail.
//
// One exhaustive `Record<Lens, Record<SectionId, Relevance>>` — TS forces every
// lens to declare a stance on every section, so a new SectionId is a type error
// until all four lenses classify it.
//
// PROMOTE, NEVER DIM (UI redesign, 2026-06-02). Earlier this model had a `dim`
// (Tier-3 opacity) + `mask` (hide) state; the operator rejected both — a feature
// dimmed to ~0.55 opacity reads as DISABLED ("only usable if you know the click
// order"). A lens now re-weights by ORDER ONLY: lead sections float to the top at
// full strength; everything else stays at full opacity and sorts below. No
// opacity, no weight-drop, no hiding — every feature is always legibly active.
// (The richer grouping/size/label emphasis lands with the command-deck grid; this
// module's contract is just lead-vs-rest ordering.)

import type { Lens } from './lens';

/** A PointReadout data section. Matches the `data-section` attrs in the template. */
export type SectionId =
	| 'bortle'
	| 'viirs'
	| 'worldAtlas'
	| 'atmosphere'
	| 'aqi'
	| 'pm25'
	| 'pollutants'
	| 'history'
	| 'pollen'
	| 'crossval'
	| 'ephemeris';

/**
 * A lens's stance on a section — ALL render at full opacity + full weight:
 * - `lead`    — the lens's signature data; floats to the top (Tier-1 headline accent).
 * - `support` — relevant to this lens; normal position.
 * - `more`    — off-lens; sorts below, still full strength + fully interactive
 *               (never dimmed, never hidden — the command-deck groups it under a
 *               visible "More" header, but it is always one obvious step away).
 */
export type Relevance = 'lead' | 'support' | 'more';

/** Every (lens × section) cell is explicit — TS enforces exhaustiveness. */
export const READOUT_RELEVANCE: Record<Lens, Record<SectionId, Relevance>> = {
	sky: {
		bortle: 'lead',
		ephemeris: 'lead',
		viirs: 'support',
		worldAtlas: 'support',
		atmosphere: 'support',
		aqi: 'more',
		pm25: 'more',
		pollutants: 'more',
		history: 'more',
		pollen: 'more',
		crossval: 'more',
	},
	air: {
		aqi: 'lead',
		pm25: 'lead',
		atmosphere: 'support',
		pollutants: 'support',
		history: 'support',
		pollen: 'support',
		crossval: 'support',
		bortle: 'more',
		viirs: 'more',
		worldAtlas: 'more',
		ephemeris: 'more',
	},
	links: {
		atmosphere: 'lead',
		ephemeris: 'support',
		aqi: 'more',
		pm25: 'more',
		pollutants: 'more',
		pollen: 'more',
		history: 'more',
		crossval: 'more',
		bortle: 'more',
		viirs: 'more',
		worldAtlas: 'more',
	},
	orbit: {
		ephemeris: 'lead',
		atmosphere: 'support',
		bortle: 'support',
		aqi: 'more',
		pm25: 'more',
		pollutants: 'more',
		pollen: 'more',
		history: 'more',
		crossval: 'more',
		viirs: 'more',
		worldAtlas: 'more',
	},
};

/** This lens's stance on this section. */
export const relevanceFor = (lens: Lens, id: SectionId): Relevance => READOUT_RELEVANCE[lens][id];

/**
 * Visual tier: 1 = lead (full headline accent), 2 = everything else (normal).
 * There is NO Tier-3 — the redesign promotes by order, never dims. Kept as a
 * 1|2 signal so the lead section can take the large/accent headline treatment.
 */
export const tierFor = (lens: Lens, id: SectionId): 1 | 2 => (relevanceFor(lens, id) === 'lead' ? 1 : 2);

/**
 * Flex `order`: lead floats up (-1), support neutral (0), `more` sorts to the
 * bottom (+2). The gap at +1 is reserved for the PointReadout "More — N ▾"
 * disclosure divider, which sits between the support group and the more group.
 */
export const orderFor = (lens: Lens, id: SectionId): number => {
	const r = relevanceFor(lens, id);
	return r === 'lead' ? -1 : r === 'more' ? 2 : 0;
};
