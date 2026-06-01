import { describe, expect, it } from 'vitest';
import { DEFAULT_LENS, isLens, LENSES } from './lens';

describe('lens', () => {
	it('exposes the four lenses in switcher order', () => {
		expect(LENSES).toEqual(['sky', 'air', 'links', 'orbit']);
	});

	it('defaults to sky', () => {
		expect(DEFAULT_LENS).toBe('sky');
		expect(isLens(DEFAULT_LENS)).toBe(true);
	});

	it('isLens accepts the exact union and rejects everything else', () => {
		for (const l of LENSES) expect(isLens(l)).toBe(true);
		expect(isLens('Sky')).toBe(false); // case-sensitive
		expect(isLens('weather')).toBe(false);
		expect(isLens('')).toBe(false);
		expect(isLens(null)).toBe(false);
		expect(isLens(undefined)).toBe(false);
		expect(isLens(1)).toBe(false);
	});
});
