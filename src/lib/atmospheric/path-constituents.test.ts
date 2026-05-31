import { describe, expect, it } from 'vitest';
import { aggregatePath } from './path-constituents';

describe('aggregatePath', () => {
	it('returns null with no coverage', () => {
		expect(aggregatePath([])).toBeNull();
		expect(aggregatePath([null, null])).toBeNull();
	});

	it('computes min/max/mean over present samples', () => {
		const p = aggregatePath([0.1, 0.2, 0.3]);
		expect(p).not.toBeNull();
		expect(p!.min).toBeCloseTo(0.1, 9);
		expect(p!.max).toBeCloseTo(0.3, 9);
		expect(p!.mean).toBeCloseTo(0.2, 9);
		expect(p!.samples).toBe(3);
	});

	it('skips null samples (no fabrication) but keeps real ones', () => {
		const p = aggregatePath([null, 0.15, null, 0.25]);
		expect(p!.samples).toBe(2);
		expect(p!.min).toBeCloseTo(0.15, 9);
		expect(p!.max).toBeCloseTo(0.25, 9);
		expect(p!.mean).toBeCloseTo(0.2, 9);
	});

	it('ignores non-finite values', () => {
		const p = aggregatePath([Number.NaN, 0.4, Number.POSITIVE_INFINITY]);
		expect(p!.samples).toBe(1);
		expect(p!.mean).toBeCloseTo(0.4, 9);
	});

	it('handles a single sample', () => {
		const p = aggregatePath([0.18]);
		expect(p).toMatchObject({ min: 0.18, max: 0.18, mean: 0.18, samples: 1 });
	});
});
