import { describe, expect, it } from 'vitest';
import type { BucketPolicy } from '$lib/effect/services/CachePolicy';
import type { CacheEntryMeta } from '$lib/effect/services/OfflineCacheService';
import { buildInspectorRows, buildInspectorTotals, formatBytes } from './inspector';

const MB = 1024 * 1024;

const entry = (
	bucket: CacheEntryMeta['bucket'],
	key: string,
	bytes: number,
	storedAt = '2026-05-28T00:00:00Z',
): CacheEntryMeta => ({ bucket, key, bytes, storedAt });

describe('buildInspectorRows — default policy', () => {
	it('emits a row for every policy bucket even when the snapshot is empty', () => {
		const rows = buildInspectorRows({ entries: [] });
		// 6 policy buckets: raster-tile, atmospheric-tile, ephemeris,
		// static-projection, route, app-shell.
		expect(rows).toHaveLength(6);
		for (const r of rows) {
			expect(r.bytesUsed).toBe(0);
			expect(r.entryCount).toBe(0);
		}
	});

	it('sorts rows by eviction priority (raster/atmospheric first, app-shell last)', () => {
		const rows = buildInspectorRows({ entries: [] });
		expect(rows[0].bucket).toMatch(/raster-tile|atmospheric-tile/);
		expect(rows[1].bucket).toMatch(/raster-tile|atmospheric-tile/);
		expect(rows[rows.length - 1].bucket).toBe('app-shell');
	});

	it('canClear is false only for app-shell', () => {
		const rows = buildInspectorRows({ entries: [] });
		for (const r of rows) {
			expect(r.canClear).toBe(r.bucket !== 'app-shell');
		}
	});

	it('label + description are present for every row', () => {
		const rows = buildInspectorRows({ entries: [] });
		for (const r of rows) {
			expect(r.label.length).toBeGreaterThan(0);
			expect(r.description.length).toBeGreaterThan(0);
		}
	});
});

describe('buildInspectorRows — tally', () => {
	it('sums bytes per bucket across entries', () => {
		const rows = buildInspectorRows({
			entries: [
				entry('raster-tile', 'r1', 3 * MB),
				entry('raster-tile', 'r2', 2 * MB),
				entry('ephemeris', 'e1', 100 * 1024),
			],
		});
		const raster = rows.find((r) => r.bucket === 'raster-tile')!;
		expect(raster.bytesUsed).toBe(5 * MB);
		expect(raster.entryCount).toBe(2);
		const ephem = rows.find((r) => r.bucket === 'ephemeris')!;
		expect(ephem.bytesUsed).toBe(100 * 1024);
		expect(ephem.entryCount).toBe(1);
	});

	it('computes fractionOfTarget = bytesUsed / target, capped at 2', () => {
		const rows = buildInspectorRows({
			entries: [
				// Raster-tile target is 12 MiB by default; 6 MiB → 0.5.
				entry('raster-tile', 'r1', 6 * MB),
				// Ephemeris target is 4 MiB; load 99 MiB to force overflow capping.
				entry('ephemeris', 'e1', 99 * MB),
			],
		});
		const raster = rows.find((r) => r.bucket === 'raster-tile')!;
		expect(raster.fractionOfTarget).toBeCloseTo(0.5, 6);
		const ephem = rows.find((r) => r.bucket === 'ephemeris')!;
		expect(ephem.fractionOfTarget).toBe(2); // clamped overflow
	});

	it('fractionOfTarget is undefined when the row has no target (app-shell)', () => {
		const rows = buildInspectorRows({ entries: [entry('app-shell', 'a1', 5 * MB)] });
		const shell = rows.find((r) => r.bucket === 'app-shell')!;
		expect(shell.targetBytes).toBeUndefined();
		expect(shell.fractionOfTarget).toBeUndefined();
		expect(shell.bytesUsed).toBe(5 * MB);
	});
});

describe('buildInspectorRows — orphan buckets', () => {
	it('appends an orphan row for entries whose bucket is not in the policy', () => {
		const tinyPolicy: ReadonlyArray<BucketPolicy> = [{ bucket: 'raster-tile', targetBytes: 1 * MB, priority: 1 }];
		const rows = buildInspectorRows(
			{ entries: [entry('raster-tile', 'r1', 1 * MB), entry('ephemeris', 'e1', 50 * 1024)] },
			tinyPolicy,
		);
		expect(rows).toHaveLength(2);
		expect(rows[0].bucket).toBe('raster-tile'); // from policy
		expect(rows[1].bucket).toBe('ephemeris'); // orphan
		expect(rows[1].targetBytes).toBeUndefined();
		expect(rows[1].fractionOfTarget).toBeUndefined();
	});
});

describe('buildInspectorTotals', () => {
	it('sums bytes used, target bytes (skipping app-shell), and entry counts', () => {
		const rows = buildInspectorRows({
			entries: [entry('raster-tile', 'r1', 5 * MB), entry('app-shell', 'a1', 10 * MB)],
		});
		const totals = buildInspectorTotals(rows);
		expect(totals.totalBytesUsed).toBe(15 * MB);
		expect(totals.totalEntries).toBe(2);
		// Total target is the sum across managed buckets (app-shell contributes 0).
		// Default policy: 12 + 8 + 4 + 2 + 2 = 28 MiB.
		expect(totals.totalTargetBytes).toBe(28 * MB);
	});
});

describe('formatBytes', () => {
	it('renders B / KiB / MiB / GiB with sensible precision', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(1024)).toBe('1.0 KiB');
		expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MiB');
		expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GiB');
	});
});
