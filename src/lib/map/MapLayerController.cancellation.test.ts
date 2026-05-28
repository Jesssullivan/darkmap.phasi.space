import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	makeMapLayerControllerLive,
	MapLayerController,
	type LayerLifecycleState,
	type MapLibreSurface,
	type RasterMount,
} from './MapLayerController';

/**
 * Race-case suite for the #194 generation-token cancellation. The
 * existing `MapLayerController.test.ts` covers the idempotent
 * happy-path baseline; this file targets the cancellation invariants:
 *
 *   1. Mount canceled by an unmount before style.load resolves does
 *      not add anything to the map.
 *   2. Mount → Unmount → Mount converges to exactly one source/layer
 *      pair, never zero or two.
 *   3. stateOf reflects the lifecycle correctly across awaits.
 *
 * We use a hand-rolled `FakeMapLibreMap` so we can deterministically
 * defer style.load and trigger the cancellation window.
 */

class FakeMapLibreMap implements MapLibreSurface {
	private sources = new Set<string>();
	private layers = new Map<string, { paint: Record<string, unknown> }>();
	private pendingStyleListeners: Array<() => void> = [];
	private styleLoaded = true;
	public calls: Array<{
		readonly op: 'addSource' | 'removeSource' | 'addLayer' | 'removeLayer' | 'setPaintProperty';
		readonly id: string;
	}> = [];

	withDeferredStyle(): this {
		this.styleLoaded = false;
		return this;
	}

	flushStyleLoad(): void {
		this.styleLoaded = true;
		const ls = this.pendingStyleListeners;
		this.pendingStyleListeners = [];
		ls.forEach((l) => l());
	}

	isStyleLoaded(): boolean {
		return this.styleLoaded;
	}

	once(event: string, cb: () => void): void {
		if (event === 'style.load') {
			if (this.styleLoaded) cb();
			else this.pendingStyleListeners.push(cb);
		}
	}

	getSource(id: string): unknown {
		return this.sources.has(id) ? { id } : undefined;
	}

	getLayer(id: string): unknown {
		return this.layers.get(id);
	}

	addSource(id: string): void {
		this.sources.add(id);
		this.calls.push({ op: 'addSource', id });
	}

	addLayer(spec: Record<string, unknown>): void {
		this.layers.set(spec.id as string, { paint: (spec.paint as Record<string, unknown>) ?? {} });
		this.calls.push({ op: 'addLayer', id: spec.id as string });
	}

	removeSource(id: string): void {
		this.sources.delete(id);
		this.calls.push({ op: 'removeSource', id });
	}

	removeLayer(id: string): void {
		this.layers.delete(id);
		this.calls.push({ op: 'removeLayer', id });
	}

	setPaintProperty(layerId: string, prop: string, value: unknown): void {
		const layer = this.layers.get(layerId);
		if (layer) layer.paint[prop] = value;
		this.calls.push({ op: 'setPaintProperty', id: layerId });
	}

	get sourceCount(): number {
		return this.sources.size;
	}
	get layerCount(): number {
		return this.layers.size;
	}
}

const mountSpec = (id: string, overrides: Partial<RasterMount> = {}): RasterMount => ({
	id,
	tileUrlTemplate: `/tiles/${id}/{z}/{x}/{y}`,
	opacity: 0.8,
	...overrides,
});

let map: FakeMapLibreMap;
let layer: ReturnType<typeof makeMapLayerControllerLive>;

const setup = (deferStyle = false): void => {
	map = new FakeMapLibreMap();
	if (deferStyle) map.withDeferredStyle();
	layer = makeMapLayerControllerLive(map);
};

afterEach(() => {
	if (map) map.calls.length = 0;
});

const runMount = (spec: RasterMount) =>
	Effect.runPromiseExit(
		Effect.gen(function* () {
			const ctl = yield* MapLayerController;
			yield* ctl.mount(spec);
		}).pipe(Effect.provide(layer)),
	);

const runUnmount = (id: string) =>
	Effect.runPromiseExit(
		Effect.gen(function* () {
			const ctl = yield* MapLayerController;
			yield* ctl.unmount(id);
		}).pipe(Effect.provide(layer)),
	);

const stateOf = async (id: string): Promise<LayerLifecycleState> => {
	const exit = await Effect.runPromiseExit(
		Effect.gen(function* () {
			const ctl = yield* MapLayerController;
			return ctl.stateOf(id);
		}).pipe(Effect.provide(layer)),
	);
	if (exit._tag !== 'Success') throw new Error('stateOf failed');
	return exit.value;
};

describe('MapLayerController — generation-token cancellation (#194)', () => {
	it('mount canceled by unmount does not add anything when style.load resolves late', async () => {
		setup(true); // style deferred
		const mountPromise = runMount(mountSpec('a'));
		const unmountPromise = runUnmount('a');
		// Both effects are parked on awaitStyle. Flush.
		map.flushStyleLoad();
		await Promise.all([mountPromise, unmountPromise]);
		// The unmount bumped the generation while the mount was parked; the
		// mount's post-style branch saw the stale token and bailed.
		expect(map.sourceCount).toBe(0);
		expect(map.layerCount).toBe(0);
	});

	it('rapid mount → unmount → mount converges to exactly one source/layer', async () => {
		setup(true);
		const p1 = runMount(mountSpec('a'));
		const p2 = runUnmount('a');
		const p3 = runMount(mountSpec('a'));
		map.flushStyleLoad();
		await Promise.all([p1, p2, p3]);
		expect(map.sourceCount).toBe(1);
		expect(map.layerCount).toBe(1);
		expect((await stateOf('a')).tag).toBe('mounted');
	});

	it('two pending mounts on different ids both land after style.load', async () => {
		setup(true);
		const p1 = runMount(mountSpec('a'));
		const p2 = runMount(mountSpec('b'));
		map.flushStyleLoad();
		await Promise.all([p1, p2]);
		expect(map.sourceCount).toBe(2);
		expect(map.layerCount).toBe(2);
	});

	it('rapid mount-a + mount-b + unmount-a settles to b alone', async () => {
		setup(true);
		const m1 = runMount(mountSpec('a'));
		const m2 = runMount(mountSpec('b'));
		const u1 = runUnmount('a');
		map.flushStyleLoad();
		await Promise.all([m1, m2, u1]);
		expect(map.sourceCount).toBe(1);
		expect(map.layerCount).toBe(1);
	});
});

describe('MapLayerController — stateOf (#194)', () => {
	it('returns idle for never-touched ids', async () => {
		setup();
		expect((await stateOf('never-mounted')).tag).toBe('idle');
	});

	it('reflects loading during a pending mount, then mounted after style.load', async () => {
		setup(true);
		const pending = runMount(mountSpec('a'));
		expect((await stateOf('a')).tag).toBe('loading');
		map.flushStyleLoad();
		await pending;
		expect((await stateOf('a')).tag).toBe('mounted');
	});

	it('returns to idle after a clean unmount', async () => {
		setup();
		await runMount(mountSpec('a'));
		await runUnmount('a');
		expect((await stateOf('a')).tag).toBe('idle');
	});

	it('generation increments on each mount/unmount cycle', async () => {
		setup();
		await runMount(mountSpec('a'));
		const after1 = (await stateOf('a')).generation;
		await runUnmount('a');
		const after2 = (await stateOf('a')).generation;
		await runMount(mountSpec('a'));
		const after3 = (await stateOf('a')).generation;
		expect(after2).toBeGreaterThan(after1);
		expect(after3).toBeGreaterThan(after2);
	});
});
