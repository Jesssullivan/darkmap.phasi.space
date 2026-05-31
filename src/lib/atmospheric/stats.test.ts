import { describe, expect, it } from 'vitest';
import { isFiniteNumber, median } from './stats';

describe('isFiniteNumber', () => {
	it('accepts real finite numbers including 0 and negatives', () => {
		expect(isFiniteNumber(0)).toBe(true);
		expect(isFiniteNumber(-3.2)).toBe(true);
		expect(isFiniteNumber(12)).toBe(true);
	});

	it('rejects null, undefined, NaN, and infinities', () => {
		expect(isFiniteNumber(null)).toBe(false);
		expect(isFiniteNumber(undefined)).toBe(false);
		expect(isFiniteNumber(NaN)).toBe(false);
		expect(isFiniteNumber(Infinity)).toBe(false);
		expect(isFiniteNumber(-Infinity)).toBe(false);
	});
});

describe('median', () => {
	it('returns the middle element for an odd count', () => {
		expect(median([3, 1, 2])).toBe(2);
	});

	it('averages the middle pair for an even count', () => {
		expect(median([1, 2, 3, 4])).toBe(2.5);
		expect(median([10, 0])).toBe(5);
	});

	it('does not mutate the input', () => {
		const xs = [3, 1, 2];
		median(xs);
		expect(xs).toEqual([3, 1, 2]);
	});

	it('returns NaN for an empty array', () => {
		expect(median([])).toBeNaN();
	});
});
