// Per-lens PointReadout relevance — the single source of truth for which
// readout sections lead, support, dim, or (eventually) hide under each lens.
//
// This replaces the prior two hand-maintained arrays (LENS_LEAD / LENS_DIM in
// PointReadout.svelte). That pair had a latent gap: a section in *neither*
// array silently fell through to Tier-2 ("support"), so forgetting to classify
// a new section produced a full-bright row with no compile-time warning. Here
// the table is **exhaustive** — `Record<Lens, Record<SectionId, Relevance>>`
// forces every lens to declare a stance on every section, so a new SectionId is
// a type error until all four lenses classify it.
//
// Re-weight, never gate: 'lead'/'support'/'dim' all stay rendered + interactive
// (they only change tier + order). 'mask' is the fourth, genuinely-hide state —
// defined here now but NOT yet rendered anywhere (it lands in the portal PR8,
// scoped conservatively). Until then no cell maps to 'mask', so this module is a
// behavior-preserving extraction: tierFor/orderFor reproduce the old
// tierOf/orderOf exactly.

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
 * A lens's stance on a section:
 * - `lead`    — float to the top, Tier-1 (the lens's signature data).
 * - `support` — present at normal weight, Tier-2 (relevant, not the headline).
 * - `dim`     — Tier-3, sunk below normal but still focusable + clickable.
 * - `mask`    — genuinely irrelevant to this lens; hidden (PR8, not yet rendered).
 *               NEVER applied to a section the lens-reweight smoke names by tier.
 */
export type Relevance = 'lead' | 'support' | 'dim' | 'mask';

/** Every (lens × section) cell is explicit — TS enforces exhaustiveness. */
export const READOUT_RELEVANCE: Record<Lens, Record<SectionId, Relevance>> = {
	sky: {
		bortle: 'lead',
		ephemeris: 'lead',
		viirs: 'support',
		worldAtlas: 'support',
		atmosphere: 'support',
		aqi: 'dim',
		pm25: 'dim',
		pollutants: 'dim',
		history: 'dim',
		pollen: 'dim',
		crossval: 'dim',
	},
	air: {
		aqi: 'lead',
		pm25: 'lead',
		atmosphere: 'support',
		pollutants: 'support',
		history: 'support',
		pollen: 'support',
		crossval: 'support',
		bortle: 'dim',
		viirs: 'dim',
		worldAtlas: 'dim',
		ephemeris: 'dim',
	},
	links: {
		atmosphere: 'lead',
		ephemeris: 'support',
		aqi: 'dim',
		pm25: 'dim',
		pollutants: 'dim',
		pollen: 'dim',
		history: 'dim',
		crossval: 'dim',
		bortle: 'dim',
		viirs: 'dim',
		worldAtlas: 'dim',
	},
	orbit: {
		ephemeris: 'lead',
		atmosphere: 'support',
		bortle: 'support',
		aqi: 'dim',
		pm25: 'dim',
		pollutants: 'dim',
		pollen: 'dim',
		history: 'dim',
		crossval: 'dim',
		viirs: 'dim',
		worldAtlas: 'dim',
	},
};

/** This lens's stance on this section. */
export const relevanceFor = (lens: Lens, id: SectionId): Relevance => READOUT_RELEVANCE[lens][id];

/**
 * Visual tier: 1 = lead (full amber/cyan headline), 2 = support (normal),
 * 3 = dim (Tier-3 opacity, still interactive). 'mask' maps to 2 here so that
 * if a section is ever marked 'mask' but still rendered (the pre-PR8 state),
 * it reads as a normal row rather than vanishing — masking is gated at the
 * template `{#if}`, not via tier.
 */
export const tierFor = (lens: Lens, id: SectionId): 1 | 2 | 3 => {
	const r = relevanceFor(lens, id);
	return r === 'lead' ? 1 : r === 'dim' ? 3 : 2;
};

/** Flex `order`: lead floats up (-1), dim sinks (1), everything else neutral (0). */
export const orderFor = (lens: Lens, id: SectionId): number => {
	const r = relevanceFor(lens, id);
	return r === 'lead' ? -1 : r === 'dim' ? 1 : 0;
};
