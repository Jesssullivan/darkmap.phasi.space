import { describe, expect, it } from 'vitest';
import {
	monthlyLayerId,
	monthlySourceId,
	swapMonthlyLayer,
	teardownMonthlyLayer,
	type MonthlyMapAdapter,
} from './monthlySwap';

interface Call {
	op: string;
	args: unknown[];
}

const makeMock = (initialSources: string[] = [], initialLayers: string[] = []) => {
	const sources = new Set(initialSources);
	const layers = new Set(initialLayers);
	const calls: Call[] = [];
	let idleHandler: (() => void) | undefined;
	const adapter: MonthlyMapAdapter = {
		getSource: (id) => sources.has(id),
		getLayer: (id) => layers.has(id),
		addSource: (id, opts) => {
			sources.add(id);
			calls.push({ op: 'addSource', args: [id, opts] });
		},
		removeSource: (id) => {
			sources.delete(id);
			calls.push({ op: 'removeSource', args: [id] });
		},
		addLayer: (spec, beforeId) => {
			layers.add(spec.id);
			calls.push({ op: 'addLayer', args: [spec, beforeId] });
		},
		removeLayer: (id) => {
			layers.delete(id);
			calls.push({ op: 'removeLayer', args: [id] });
		},
		setPaintProperty: (id, prop, value) => {
			calls.push({ op: 'setPaintProperty', args: [id, prop, value] });
		},
		once: (event, handler) => {
			calls.push({ op: 'once', args: [event] });
			if (event === 'idle') idleHandler = handler;
		},
	};
	const fireIdle = () => idleHandler?.();
	return { adapter, calls, sources, layers, fireIdle };
};

const TMPL = (id: string) => `/api/raster?layer=${id}&z={z}&x={x}&y={y}`;

describe('monthlySwap', () => {
	it('mounts a new layer with the requested opacity when nothing is currently mounted', async () => {
		const mock = makeMock();
		const promise = swapMonthlyLayer(mock.adapter, {
			oldLayerId: null,
			newLayerId: 'viirs_2020_07',
			opacity: 0.85,
			tileUrlTemplate: TMPL,
		});
		await promise;
		expect(mock.layers.has(monthlyLayerId('viirs_2020_07'))).toBe(true);
		expect(mock.sources.has(monthlySourceId('viirs_2020_07'))).toBe(true);
		expect(mock.calls.some((c) => c.op === 'once')).toBe(false);
	});

	it('adds the new layer + waits for idle + removes the old when swapping', async () => {
		const mock = makeMock([monthlySourceId('viirs_2020_07')], [monthlyLayerId('viirs_2020_07')]);
		let resolved = false;
		const promise = swapMonthlyLayer(mock.adapter, {
			oldLayerId: 'viirs_2020_07',
			newLayerId: 'viirs_2020_08',
			opacity: 0.85,
			tileUrlTemplate: TMPL,
		}).then(() => {
			resolved = true;
		});
		// New layer added; old still mounted; swap is awaiting idle.
		await Promise.resolve();
		expect(mock.layers.has(monthlyLayerId('viirs_2020_08'))).toBe(true);
		expect(mock.layers.has(monthlyLayerId('viirs_2020_07'))).toBe(true);
		expect(resolved).toBe(false);
		// Fire idle — old should be removed and promise resolves.
		mock.fireIdle();
		await promise;
		expect(mock.layers.has(monthlyLayerId('viirs_2020_07'))).toBe(false);
		expect(mock.sources.has(monthlySourceId('viirs_2020_07'))).toBe(false);
	});

	it('only updates paint opacity when newLayerId already mounted', async () => {
		const id = monthlyLayerId('viirs_2020_07');
		const mock = makeMock([monthlySourceId('viirs_2020_07')], [id]);
		await swapMonthlyLayer(mock.adapter, {
			oldLayerId: 'viirs_2020_07',
			newLayerId: 'viirs_2020_07',
			opacity: 0.5,
			tileUrlTemplate: TMPL,
		});
		expect(mock.calls.some((c) => c.op === 'addLayer')).toBe(false);
		expect(mock.calls).toContainEqual({
			op: 'setPaintProperty',
			args: [id, 'raster-opacity', 0.5],
		});
		// No idle wait because oldLayerId === newLayerId.
		expect(mock.calls.some((c) => c.op === 'once')).toBe(false);
	});

	it('uses stable id pattern darkmap-monthly-<id>-src / -lyr', () => {
		expect(monthlySourceId('viirs_2020_07')).toBe('darkmap-monthly-viirs_2020_07-src');
		expect(monthlyLayerId('viirs_2020_07')).toBe('darkmap-monthly-viirs_2020_07-lyr');
	});

	it('teardownMonthlyLayer removes the current layer + source if mounted', () => {
		const mock = makeMock([monthlySourceId('viirs_2020_07')], [monthlyLayerId('viirs_2020_07')]);
		teardownMonthlyLayer(mock.adapter, 'viirs_2020_07');
		expect(mock.layers.size).toBe(0);
		expect(mock.sources.size).toBe(0);
	});

	it('teardownMonthlyLayer is a no-op when currentLayerId is null', () => {
		const mock = makeMock();
		teardownMonthlyLayer(mock.adapter, null);
		expect(mock.calls).toHaveLength(0);
	});
});
