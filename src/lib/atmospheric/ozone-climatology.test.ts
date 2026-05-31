import { describe, expect, it } from 'vitest';
import { columnOzoneDu, dayOfYearUTC } from './ozone-climatology';

describe('dayOfYearUTC', () => {
	it('is 1 on Jan 1 and 365 on Dec 31 (non-leap)', () => {
		expect(dayOfYearUTC(new Date('2026-01-01T00:00:00Z'))).toBe(1);
		expect(dayOfYearUTC(new Date('2026-12-31T00:00:00Z'))).toBe(365);
	});
});

describe('columnOzoneDu (van Heuklon 1979)', () => {
	it('reduces to the 235 DU baseline at the equator (latitude term vanishes)', () => {
		expect(columnOzoneDu(0, 0, new Date('2026-03-21T00:00:00Z'))).toBeCloseTo(235, 6);
		expect(columnOzoneDu(0, 120, new Date('2026-07-01T00:00:00Z'))).toBeCloseTo(235, 6);
	});

	it('matches a hand-computed northern mid-latitude value', () => {
		// lat 45°N, lon 0, Jan 1 (doy 1): Ω = 235 + 130.85·sin²(57.6°) ≈ 328.3 DU.
		expect(columnOzoneDu(45, 0, new Date('2026-01-01T00:00:00Z'))).toBeCloseTo(328.3, 0);
	});

	it('gives higher column ozone toward the poles than the tropics', () => {
		const date = new Date('2026-03-21T00:00:00Z');
		const tropic = columnOzoneDu(10, 0, date);
		const mid = columnOzoneDu(45, 0, date);
		const high = columnOzoneDu(65, 0, date);
		expect(mid).toBeGreaterThan(tropic);
		expect(high).toBeGreaterThan(mid);
	});

	it('shows a seasonal swing at mid-latitudes (spring > autumn in the north)', () => {
		const spring = columnOzoneDu(50, 0, new Date('2026-04-01T00:00:00Z'));
		const autumn = columnOzoneDu(50, 0, new Date('2026-10-01T00:00:00Z'));
		expect(spring).toBeGreaterThan(autumn);
	});

	it('uses the southern-hemisphere constants below the equator', () => {
		// Symmetric latitudes are NOT equal — different A/B/C/F/H/I per hemisphere.
		const n = columnOzoneDu(45, 0, new Date('2026-03-21T00:00:00Z'));
		const s = columnOzoneDu(-45, 0, new Date('2026-03-21T00:00:00Z'));
		expect(n).not.toBeCloseTo(s, 1);
		expect(s).toBeGreaterThan(235);
	});

	it('stays in a physically sane range across the globe and year', () => {
		for (const lat of [-80, -45, 0, 30, 60, 85]) {
			for (const doy of ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']) {
				const v = columnOzoneDu(lat, 0, new Date(`${doy}T00:00:00Z`));
				expect(v).toBeGreaterThan(180);
				expect(v).toBeLessThan(600);
			}
		}
	});
});
