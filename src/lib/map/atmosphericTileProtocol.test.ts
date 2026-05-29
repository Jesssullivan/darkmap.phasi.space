import { describe, expect, it, vi } from 'vitest';
import type { HealthEvent, LayerHealth } from '$lib/layers/health-state';
import {
	ATMO_PROTOCOL,
	atmosphericTileTemplate,
	layerIdFromTileUrl,
	makeAtmosphericTileLoader,
	stripAtmoScheme,
	withAtmoScheme,
} from './atmosphericTileProtocol';

const TILE_URL = `${ATMO_PROTOCOL}:///api/raster?layer=clouds-modis-terra&z=4&x=5&y=6&kind=atmospheric`;

const pngBytes = () => new Uint8Array([137, 80, 78, 71]).buffer;

const res = (status: number, outcome?: string): Response => {
	const headers = new Headers();
	if (outcome) headers.set('x-darkmap-atmospheric-outcome', outcome);
	return new Response(status === 204 ? null : pngBytes(), { status, headers });
};

interface Captured {
	readonly events: Array<{ id: string; event: HealthEvent }>;
}

const makeDeps = (opts: { fetchImpl: typeof fetch; health?: LayerHealth }) => {
	const captured: Captured = { events: [] };
	const deps = {
		fetchImpl: opts.fetchImpl,
		getHealth: (): LayerHealth => opts.health ?? { tag: 'loading' },
		dispatch: (id: string, event: HealthEvent) => captured.events.push({ id, event }),
	};
	return { deps, captured };
};

const noAbort = { signal: new AbortController().signal };

/* ----------------------------- URL helpers ----------------------------- */

describe('scheme + layer-id helpers', () => {
	it('withAtmoScheme / stripAtmoScheme round-trip', () => {
		const rel = '/api/raster?layer=aerosol-modis-aod&z=1&x=0&y=0&kind=atmospheric';
		expect(stripAtmoScheme(withAtmoScheme(rel))).toBe(rel);
	});

	it('stripAtmoScheme is a no-op on an unschemed URL', () => {
		expect(stripAtmoScheme('/api/raster?layer=x')).toBe('/api/raster?layer=x');
	});

	it('atmosphericTileTemplate produces a schemed proxy URL tagged kind=atmospheric', () => {
		const tpl = atmosphericTileTemplate('clouds-modis-terra');
		expect(tpl.startsWith(`${ATMO_PROTOCOL}://`)).toBe(true);
		expect(tpl).toContain('/api/raster?layer=clouds-modis-terra');
		expect(tpl).toContain('&kind=atmospheric');
	});

	it('layerIdFromTileUrl pulls the layer param from a schemed url', () => {
		expect(layerIdFromTileUrl(TILE_URL)).toBe('clouds-modis-terra');
	});

	it('layerIdFromTileUrl returns undefined when no query', () => {
		expect(layerIdFromTileUrl(`${ATMO_PROTOCOL}:///api/raster`)).toBeUndefined();
	});
});

/* ------------------------------- loader ------------------------------- */

describe('makeAtmosphericTileLoader', () => {
	it('dispatches tile-ok and returns bytes for an ok outcome', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(res(200, 'ok'));
		const { deps, captured } = makeDeps({ fetchImpl });
		const loader = makeAtmosphericTileLoader(deps);

		const out = await loader({ url: TILE_URL }, noAbort);
		expect(out.data.byteLength).toBeGreaterThan(0);
		// fetch hit the de-schemed real URL (so it still flows through the SW)
		expect(fetchImpl).toHaveBeenCalledWith('/api/raster?layer=clouds-modis-terra&z=4&x=5&y=6&kind=atmospheric', {
			signal: noAbort.signal,
		});
		expect(captured.events).toEqual([{ id: 'clouds-modis-terra', event: { type: 'tile-ok' } }]);
	});

	it('treats a missing outcome header as ok (legacy / cached responses)', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(res(200));
		const { deps, captured } = makeDeps({ fetchImpl });
		await makeAtmosphericTileLoader(deps)({ url: TILE_URL }, noAbort);
		expect(captured.events[0].event.type).toBe('tile-ok');
	});

	it('dispatches tile-empty for a no-data outcome when not yet rendered', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(res(200, 'no-data'));
		const { deps, captured } = makeDeps({ fetchImpl, health: { tag: 'loading' } });
		const out = await makeAtmosphericTileLoader(deps)({ url: TILE_URL }, noAbort);
		// Still returns bytes (the transparent PNG) so MapLibre renders a blank tile.
		expect(out.data.byteLength).toBeGreaterThan(0);
		expect(captured.events).toEqual([
			{ id: 'clouds-modis-terra', event: { type: 'tile-empty', reason: 'no coverage for this date / area' } },
		]);
	});

	it('any-ok-wins: suppresses tile-empty once the layer is already rendered', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(res(200, 'no-data'));
		const { deps, captured } = makeDeps({ fetchImpl, health: { tag: 'rendered' } });
		await makeAtmosphericTileLoader(deps)({ url: TILE_URL }, noAbort);
		expect(captured.events).toEqual([]); // no downgrade
	});

	it('dispatches tile-error with status for a non-2xx response and throws', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(res(502));
		const { deps, captured } = makeDeps({ fetchImpl });
		await expect(makeAtmosphericTileLoader(deps)({ url: TILE_URL }, noAbort)).rejects.toThrow(/502/);
		expect(captured.events).toEqual([
			{ id: 'clouds-modis-terra', event: { type: 'tile-error', reason: 'upstream 502', status: 502 } },
		]);
	});

	it('dispatches tile-error and rethrows on a network failure', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error('NetworkError'));
		const { deps, captured } = makeDeps({ fetchImpl });
		await expect(makeAtmosphericTileLoader(deps)({ url: TILE_URL }, noAbort)).rejects.toThrow(/NetworkError/);
		expect(captured.events[0].event).toMatchObject({ type: 'tile-error', reason: 'NetworkError' });
	});

	it('rethrows an AbortError WITHOUT dispatching (our own cancellation)', async () => {
		const abortErr = new DOMException('aborted', 'AbortError');
		const fetchImpl = vi.fn().mockRejectedValue(abortErr);
		const { deps, captured } = makeDeps({ fetchImpl });
		await expect(makeAtmosphericTileLoader(deps)({ url: TILE_URL }, noAbort)).rejects.toBe(abortErr);
		expect(captured.events).toEqual([]);
	});
});
