import { describe, expect, it } from 'vitest';
import { LENSES } from './lens';
import { READOUT_RELEVANCE, orderFor, relevanceFor, tierFor, type Relevance, type SectionId } from './readoutRelevance';

// The canonical section set, derived from one lens's row. Every lens must cover
// exactly this set (asserted below), so reading it off `sky` is sufficient.
const SECTIONS = Object.keys(READOUT_RELEVANCE.sky) as SectionId[];

describe('READOUT_RELEVANCE — exhaustiveness', () => {
	it('every lens declares a stance on every section (no silent fall-through)', () => {
		for (const lens of LENSES) {
			const keys = Object.keys(READOUT_RELEVANCE[lens]).sort();
			expect(keys).toEqual([...SECTIONS].sort());
		}
	});

	it('covers all four lenses', () => {
		expect(Object.keys(READOUT_RELEVANCE).sort()).toEqual([...LENSES].sort());
	});

	it('only emits the three promote-never-dim relevance values', () => {
		const allowed: Relevance[] = ['lead', 'support', 'more'];
		for (const lens of LENSES) {
			for (const id of SECTIONS) {
				expect(allowed).toContain(relevanceFor(lens, id));
			}
		}
	});
});

describe('tierFor / orderFor — promote by order, NEVER dim', () => {
	it('lead → tier 1 + order -1 (floats to top, headline accent)', () => {
		expect(tierFor('sky', 'bortle')).toBe(1);
		expect(orderFor('sky', 'bortle')).toBe(-1);
		expect(tierFor('air', 'aqi')).toBe(1);
		expect(tierFor('links', 'atmosphere')).toBe(1);
		expect(tierFor('orbit', 'ephemeris')).toBe(1);
	});

	it('off-lens "more" → tier 2 (NOT 3) + order 2 (sorts below the "More ▾" divider, full strength)', () => {
		expect(tierFor('sky', 'aqi')).toBe(2);
		expect(orderFor('sky', 'aqi')).toBe(2);
		expect(tierFor('air', 'bortle')).toBe(2);
		expect(tierFor('links', 'viirs')).toBe(2);
	});

	it('support → tier 2 + order 0 (relevant, normal position)', () => {
		expect(tierFor('links', 'ephemeris')).toBe(2);
		expect(orderFor('links', 'ephemeris')).toBe(0);
		expect(tierFor('orbit', 'bortle')).toBe(2);
		expect(tierFor('sky', 'atmosphere')).toBe(2);
	});

	it('NEVER returns tier 3 — there is no dim state (the de-dim invariant)', () => {
		for (const lens of LENSES) {
			for (const id of SECTIONS) {
				const t = tierFor(lens, id);
				expect(t === 1 || t === 2).toBe(true);
			}
		}
	});

	it('tier and order stay consistent for every cell', () => {
		for (const lens of LENSES) {
			for (const id of SECTIONS) {
				const t = tierFor(lens, id);
				const o = orderFor(lens, id);
				// tier 1 (lead) → -1; tier 2 is support (order 0) or "more" (order 2,
				// below the "More — N ▾" divider at order 1).
				if (t === 1) expect(o).toBe(-1);
				else expect(o === 0 || o === 2).toBe(true);
			}
		}
	});
});
