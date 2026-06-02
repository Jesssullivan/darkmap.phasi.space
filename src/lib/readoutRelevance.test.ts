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

	it('only emits the four known relevance values', () => {
		const allowed: Relevance[] = ['lead', 'support', 'dim', 'mask'];
		for (const lens of LENSES) {
			for (const id of SECTIONS) {
				expect(allowed).toContain(relevanceFor(lens, id));
			}
		}
	});

	it('marks nothing as "mask" yet — the table extraction is behavior-preserving (PR8 flips mask on)', () => {
		for (const lens of LENSES) {
			for (const id of SECTIONS) {
				expect(relevanceFor(lens, id)).not.toBe('mask');
			}
		}
	});
});

describe('tierFor / orderFor — reproduce the prior LENS_LEAD/LENS_DIM behavior', () => {
	it('lead → tier 1 + order -1', () => {
		expect(tierFor('sky', 'bortle')).toBe(1);
		expect(orderFor('sky', 'bortle')).toBe(-1);
		expect(tierFor('air', 'aqi')).toBe(1);
		expect(tierFor('links', 'atmosphere')).toBe(1);
		expect(tierFor('orbit', 'ephemeris')).toBe(1);
	});

	it('dim → tier 3 + order 1', () => {
		expect(tierFor('sky', 'aqi')).toBe(3);
		expect(orderFor('sky', 'aqi')).toBe(1);
		expect(tierFor('air', 'bortle')).toBe(3);
		expect(tierFor('links', 'viirs')).toBe(3);
	});

	it('support → tier 2 + order 0 (the old implicit Tier-2 default, now explicit)', () => {
		expect(tierFor('links', 'ephemeris')).toBe(2);
		expect(orderFor('links', 'ephemeris')).toBe(0);
		expect(tierFor('orbit', 'bortle')).toBe(2);
		expect(tierFor('sky', 'atmosphere')).toBe(2);
		expect(tierFor('air', 'pollutants')).toBe(2);
	});

	it('tier and order agree on direction for every cell', () => {
		for (const lens of LENSES) {
			for (const id of SECTIONS) {
				const t = tierFor(lens, id);
				const o = orderFor(lens, id);
				if (t === 1) expect(o).toBe(-1);
				else if (t === 3) expect(o).toBe(1);
				else expect(o).toBe(0);
			}
		}
	});
});
