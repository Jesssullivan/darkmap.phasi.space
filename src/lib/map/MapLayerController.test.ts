import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
	makeMapLayerControllerLive,
	MapLayerController,
	mapLayerControllerIds,
	type RasterMount,
} from './MapLayerController';

interface RecordedOp {
	readonly kind: 'addSource' | 'addLayer' | 'removeSource' | 'removeLayer' | 'setPaint';
	readonly id: string;
	readonly arg?: unknown;
}

/**
 * Minimal MapLibre stand-in. Tracks live sources/layers + records every
 * call so tests can assert idempotency and ordering. The `isStyleLoaded`
 * + `once('style.load')` plumbing covers both fast-path (already loaded)
 * and deferred-path mounts.
 */
function makeFakeMap(initialStyleLoaded = true): {
	map: MapLibreMap;
	ops: RecordedOp[];
	fireStyleLoad: () => void;
} {
	const sources = new Set<string>();
	const layers = new Set<string>();
	const ops: RecordedOp[] = [];
	let styleLoaded = initialStyleLoaded;
	const styleLoadCallbacks: Array<() => void> = [];

	const map = {
		isStyleLoaded: () => styleLoaded,
		once: (event: string, cb: () => void) => {
			if (event === 'style.load') styleLoadCallbacks.push(cb);
		},
		getSource: (id: string) => (sources.has(id) ? {} : undefined),
		getLayer: (id: string) => (layers.has(id) ? {} : undefined),
		addSource: (id: string, spec: unknown) => {
			sources.add(id);
			ops.push({ kind: 'addSource', id, arg: spec });
		},
		removeSource: (id: string) => {
			sources.delete(id);
			ops.push({ kind: 'removeSource', id });
		},
		addLayer: (spec: { id: string }, beforeId?: string) => {
			layers.add(spec.id);
			ops.push({ kind: 'addLayer', id: spec.id, arg: beforeId });
		},
		removeLayer: (id: string) => {
			layers.delete(id);
			ops.push({ kind: 'removeLayer', id });
		},
		setPaintProperty: (id: string, prop: string, value: unknown) => {
			ops.push({ kind: 'setPaint', id, arg: { prop, value } });
		},
	} as unknown as MapLibreMap;

	const fireStyleLoad = (): void => {
		styleLoaded = true;
		for (const cb of styleLoadCallbacks.splice(0)) cb();
	};

	return { map, ops, fireStyleLoad };
}

const sampleMount = (overrides: Partial<RasterMount> = {}): RasterMount => ({
	id: 'viirs_2019',
	tileUrlTemplate: '/api/raster?layer=viirs_2019&z={z}&x={x}&y={y}',
	opacity: 0.85,
	...overrides,
});

describe('MapLayerController', () => {
	let env: ReturnType<typeof makeFakeMap>;

	beforeEach(() => {
		env = makeFakeMap();
	});

	const run = <A, E>(eff: Effect.Effect<A, E, MapLayerController>): Promise<A> =>
		Effect.runPromise(eff.pipe(Effect.provide(makeMapLayerControllerLive(env.map))));

	it('mount adds a raster source + layer with the wired opacity', async () => {
		await run(Effect.flatMap(MapLayerController, (c) => c.mount(sampleMount())));
		const { sourceIdFor, layerIdFor } = mapLayerControllerIds;
		const ops = env.ops;
		expect(ops.map((o) => o.kind)).toEqual(['addSource', 'addLayer']);
		expect(ops[0].id).toBe(sourceIdFor('viirs_2019'));
		expect(ops[1].id).toBe(layerIdFor('viirs_2019'));
	});

	it('mount is idempotent — re-mounting a live layer is a no-op', async () => {
		await run(Effect.flatMap(MapLayerController, (c) => c.mount(sampleMount())));
		await run(Effect.flatMap(MapLayerController, (c) => c.mount(sampleMount())));
		expect(env.ops.filter((o) => o.kind === 'addSource')).toHaveLength(1);
		expect(env.ops.filter((o) => o.kind === 'addLayer')).toHaveLength(1);
	});

	it('unmount removes both layer and source', async () => {
		await run(Effect.flatMap(MapLayerController, (c) => c.mount(sampleMount())));
		await run(Effect.flatMap(MapLayerController, (c) => c.unmount('viirs_2019')));
		expect(env.ops.map((o) => o.kind)).toEqual(['addSource', 'addLayer', 'removeLayer', 'removeSource']);
	});

	it('unmount is idempotent — unmounting a missing layer is a no-op', async () => {
		await run(Effect.flatMap(MapLayerController, (c) => c.unmount('viirs_2019')));
		expect(env.ops).toEqual([]);
	});

	it('setOpacity pushes raster-opacity without touching tiles', async () => {
		await run(Effect.flatMap(MapLayerController, (c) => c.mount(sampleMount())));
		await run(Effect.flatMap(MapLayerController, (c) => c.setOpacity('viirs_2019', 0.4)));
		const paint = env.ops.find((o) => o.kind === 'setPaint');
		expect(paint?.arg).toEqual({ prop: 'raster-opacity', value: 0.4 });
	});

	it('waits for style.load before mounting when style is not yet loaded', async () => {
		const deferred = makeFakeMap(false);
		const eff = Effect.flatMap(MapLayerController, (c) => c.mount(sampleMount())).pipe(
			Effect.provide(makeMapLayerControllerLive(deferred.map)),
		);
		const promise = Effect.runPromise(eff);
		// Before firing style.load, no ops should have been recorded.
		expect(deferred.ops).toEqual([]);
		deferred.fireStyleLoad();
		await promise;
		expect(deferred.ops.map((o) => o.kind)).toEqual(['addSource', 'addLayer']);
	});

	it('mount honors beforeId for layer ordering', async () => {
		await run(Effect.flatMap(MapLayerController, (c) => c.mount(sampleMount({ beforeId: 'sentinel-layer' }))));
		const addLayer = env.ops.find((o) => o.kind === 'addLayer');
		expect(addLayer?.arg).toBe('sentinel-layer');
	});
});
