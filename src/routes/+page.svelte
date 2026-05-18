<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { basemapById, BASEMAPS, DEFAULT_BASEMAP_ID } from '$lib/basemaps';
	import EphemerisGantt from '$lib/components/EphemerisGantt.svelte';
	import GeocoderSearch from '$lib/components/GeocoderSearch.svelte';
	import LayerRail, { type LayerState } from '$lib/components/LayerRail.svelte';
	import MapErrorToast, { type ToastErr } from '$lib/components/MapErrorToast.svelte';
	import PointReadout, { type ReadoutData } from '$lib/components/PointReadout.svelte';
	import SkyCompass from '$lib/components/SkyCompass.svelte';
	import TimeDock from '$lib/components/TimeDock.svelte';
	import {
		FALLBACK_CENTER,
		FALLBACK_ZOOM,
		LAYERS,
		rasterUrlTemplate,
		VIIRS_MONTHS,
		VIIRS_YEARS,
		type RasterLayerDef,
	} from '$lib/layers';
	import { prefetchMonthlyTiles } from '$lib/monthlyPrefetch';
	import { swapMonthlyLayer, teardownMonthlyLayer, type MonthlyMapAdapter } from '$lib/monthlySwap';
	import { decodeHash, encodeHash, type MonthlyMonth } from '$lib/url-hash';

	let mapEl: HTMLDivElement | undefined = $state();
	let mapInstance: import('maplibre-gl').Map | undefined;

	// Initial state honors the URL hash if present, otherwise the manifest
	// defaults. `decodeHash` runs at module load so SSR sees the default
	// state; the browser refines it inside onMount.
	const initialState = (): Record<string, LayerState> => {
		const defaults: Record<string, LayerState> = Object.fromEntries(
			LAYERS.map((l) => [l.id, { on: l.defaultEnabled, opacity: l.opacity }]),
		);
		if (!browser) return defaults;
		const parsed = decodeHash(window.location.hash);
		if (!parsed.layers) return defaults;
		// Hash overrides: any layer listed in the hash is on; others are off.
		for (const l of LAYERS) {
			const op = parsed.layers.get(l.id);
			defaults[l.id] = op === undefined ? { on: false, opacity: l.opacity } : { on: true, opacity: op };
		}
		return defaults;
	};
	const layerState: Record<string, LayerState> = $state(initialState());

	const initialBasemap = (): string => {
		if (!browser) return DEFAULT_BASEMAP_ID;
		const parsed = decodeHash(window.location.hash);
		return parsed.basemap && BASEMAPS.some((b) => b.id === parsed.basemap) ? parsed.basemap : DEFAULT_BASEMAP_ID;
	};
	let activeBasemap = $state(initialBasemap());

	// Ephemeris overlay state. Off by default; toggled via the button in the
	// bottom-right corner. `time` is the cursor instant for the gantt;
	// `center` tracks the viewport so the gantt recomputes when you pan.
	const initialTime = (): Date => {
		if (browser) {
			const parsed = decodeHash(window.location.hash);
			if (parsed.time) return parsed.time;
		}
		return new Date();
	};
	let ephemerisOpen = $state(false);
	let ephemerisTime: Date = $state(initialTime());
	let viewCenter: { lat: number; lon: number } = $state({
		lat: FALLBACK_CENTER[1],
		lon: FALLBACK_CENTER[0],
	});
	let viewBounds: { north: number; south: number; east: number; west: number } | undefined = $state();

	// VIIRS Monthly TimeDock state. Toggle controls the dock visibility; when
	// open we mount a hidden monthly raster layer and swap it on month change.
	const NEWEST_MONTH: MonthlyMonth | null =
		VIIRS_MONTHS.length > 0
			? {
					year: VIIRS_MONTHS[VIIRS_MONTHS.length - 1].year ?? 0,
					month: VIIRS_MONTHS[VIIRS_MONTHS.length - 1].month ?? 1,
				}
			: null;
	const initialMonthly = (): { open: boolean; month: MonthlyMonth | null; autoplay: boolean } => {
		if (browser) {
			const parsed = decodeHash(window.location.hash);
			if (parsed.monthlyMonth) {
				return { open: true, month: parsed.monthlyMonth, autoplay: parsed.monthlyAutoplay ?? false };
			}
		}
		return { open: false, month: NEWEST_MONTH, autoplay: false };
	};
	const initMonthly = initialMonthly();
	let monthlyOpen = $state(initMonthly.open);
	let monthlyMonth = $state<MonthlyMonth | null>(initMonthly.month);
	let monthlyAutoplay = $state(initMonthly.autoplay);
	/** Most-recently mounted monthly layer id, tracked for swap-engine teardown. */
	let mountedMonthlyLayerId: string | null = null;

	const monthlyLayerIdFor = (m: MonthlyMonth): string => `viirs_${m.year}_${m.month < 10 ? '0' + m.month : m.month}`;

	function asMonthlyAdapter(map: import('maplibre-gl').Map): MonthlyMapAdapter {
		return {
			getSource: (id) => Boolean(map.getSource(id)),
			getLayer: (id) => Boolean(map.getLayer(id)),
			addSource: (id, opts) => map.addSource(id, { type: 'raster', tiles: [...opts.tiles], tileSize: opts.tileSize }),
			removeSource: (id) => map.removeSource(id),
			addLayer: (spec, beforeId) =>
				map.addLayer({ id: spec.id, type: 'raster', source: spec.source, paint: spec.paint }, beforeId),
			removeLayer: (id) => map.removeLayer(id),
			setPaintProperty: (id, prop, value) => map.setPaintProperty(id, prop, value),
			once: (event, handler) => {
				map.once(event, () => handler());
			},
		};
	}

	async function mountMonthly(m: MonthlyMonth): Promise<void> {
		if (!mapInstance) return;
		const newId = monthlyLayerIdFor(m);
		const adapter = asMonthlyAdapter(mapInstance);
		await swapMonthlyLayer(adapter, {
			oldLayerId: mountedMonthlyLayerId,
			newLayerId: newId,
			opacity: 0.85,
			tileUrlTemplate: rasterUrlTemplate,
		});
		mountedMonthlyLayerId = newId;

		// Prefetch the next month's viewport tiles so scrubbing forward is
		// instant. Only when we have viewport bounds + a successor.
		if (viewBounds && mapInstance) {
			const idx = VIIRS_MONTHS.findIndex((l) => l.year === m.year && l.month === m.month);
			const next = idx >= 0 && idx + 1 < VIIRS_MONTHS.length ? VIIRS_MONTHS[idx + 1] : null;
			if (next && next.year !== undefined && next.month !== undefined) {
				prefetchMonthlyTiles(monthlyLayerIdFor({ year: next.year, month: next.month }), rasterUrlTemplate, {
					...viewBounds,
					zoom: mapInstance.getZoom(),
				});
			}
		}
	}

	function teardownMonthly(): void {
		if (!mapInstance) return;
		teardownMonthlyLayer(asMonthlyAdapter(mapInstance), mountedMonthlyLayerId);
		mountedMonthlyLayerId = null;
	}

	function onMonthlyToggle(): void {
		monthlyOpen = !monthlyOpen;
		if (monthlyOpen) {
			if (!monthlyMonth) monthlyMonth = NEWEST_MONTH;
			if (monthlyMonth) void mountMonthly(monthlyMonth);
		} else {
			teardownMonthly();
			monthlyAutoplay = false;
		}
		scheduleHashWrite();
	}

	function onMonthlyChange(m: MonthlyMonth): void {
		monthlyMonth = m;
		void mountMonthly(m);
		scheduleHashWrite();
	}

	function onMonthlyAutoplayChange(a: boolean): void {
		monthlyAutoplay = a;
		scheduleHashWrite();
	}

	// Map error toast state. MapLibre dispatches `'error'` for tile / source
	// load failures (e.g. /api/raster 502s). We append to this list and the
	// MapErrorToast component auto-dismisses each after a few seconds.
	let toastErrors = $state<ToastErr[]>([]);
	let toastIdSeed = 0;
	function pushToast(text: string, source?: string): void {
		const id = ++toastIdSeed;
		toastErrors = [...toastErrors, { id, text, source }];
	}
	function dismissToast(id: number): void {
		toastErrors = toastErrors.filter((e) => e.id !== id);
	}

	// Point-query readout state.
	type Readout = { lat: number; lon: number; data?: ReadoutData; loading: boolean; error?: string };
	let readout: Readout | undefined = $state();

	async function queryAt(lat: number, lon: number): Promise<void> {
		// Use the currently-active VIIRS year if any, else the newest.
		const activeViirs = VIIRS_YEARS.find((l) => layerState[l.id]?.on)?.id ?? VIIRS_YEARS[0].id;
		readout = { lat, lon, loading: true };
		try {
			const params = new URLSearchParams({
				layer: activeViirs,
				lat: String(lat),
				lon: String(lon),
			});
			const res = await fetch(`/api/featureinfo?${params}`);
			if (!res.ok) {
				readout = { lat, lon, loading: false, error: `${res.status} ${res.statusText}` };
				return;
			}
			const data = (await res.json()) as ReadoutData;
			readout = { lat, lon, loading: false, data };
		} catch (e) {
			readout = { lat, lon, loading: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	let hashWriteTimer: ReturnType<typeof setTimeout> | undefined;
	function scheduleHashWrite(): void {
		if (!browser || !mapInstance) return;
		clearTimeout(hashWriteTimer);
		hashWriteTimer = setTimeout(() => {
			if (!mapInstance) return;
			const c = mapInstance.getCenter();
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, not stored in state
			const layersMap = new Map<string, number>();
			for (const l of LAYERS) {
				const s = layerState[l.id];
				if (s?.on) layersMap.set(l.id, s.opacity);
			}
			const hash = encodeHash({
				view: { lat: c.lat, lon: c.lng, zoom: mapInstance.getZoom() },
				layers: layersMap,
				basemap: activeBasemap === DEFAULT_BASEMAP_ID ? undefined : activeBasemap,
				time: ephemerisOpen ? ephemerisTime : undefined,
				monthlyMonth: monthlyOpen && monthlyMonth ? monthlyMonth : undefined,
				monthlyAutoplay: monthlyOpen && monthlyAutoplay ? true : undefined,
			});
			history.replaceState(null, '', hash || window.location.pathname);
		}, 250);
	}

	const sourceIdFor = (l: RasterLayerDef) => `darkmap-${l.id}-src`;
	const layerIdFor = (l: RasterLayerDef) => `darkmap-${l.id}-lyr`;

	function addLayerToMap(map: import('maplibre-gl').Map, l: RasterLayerDef): void {
		if (map.getSource(sourceIdFor(l))) return;
		map.addSource(sourceIdFor(l), {
			type: 'raster',
			tiles: [rasterUrlTemplate(l.id)],
			tileSize: 256,
		});
		map.addLayer({
			id: layerIdFor(l),
			type: 'raster',
			source: sourceIdFor(l),
			paint: { 'raster-opacity': layerState[l.id]?.opacity ?? l.opacity },
		});
	}

	function removeLayerFromMap(map: import('maplibre-gl').Map, l: RasterLayerDef): void {
		if (map.getLayer(layerIdFor(l))) map.removeLayer(layerIdFor(l));
		if (map.getSource(sourceIdFor(l))) map.removeSource(sourceIdFor(l));
	}

	function onChange(id: string, partial: Partial<LayerState>): void {
		const layer = LAYERS.find((l) => l.id === id);
		if (!layer) return;
		const prev = layerState[id] ?? { on: false, opacity: layer.opacity };
		const next = { ...prev, ...partial };
		layerState[id] = next;
		if (!mapInstance) return;
		// Toggle changes: add or remove the source+layer.
		if (partial.on !== undefined && partial.on !== prev.on) {
			if (next.on) addLayerToMap(mapInstance, layer);
			else removeLayerFromMap(mapInstance, layer);
		}
		// Opacity changes: push directly to MapLibre without re-fetching tiles.
		if (partial.opacity !== undefined && partial.opacity !== prev.opacity && next.on) {
			if (mapInstance.getLayer(layerIdFor(layer))) {
				mapInstance.setPaintProperty(layerIdFor(layer), 'raster-opacity', next.opacity);
			}
		}
		scheduleHashWrite();
	}

	function getInitialView(): Promise<{ center: [number, number]; zoom: number }> {
		const fallback = { center: [...FALLBACK_CENTER] as [number, number], zoom: FALLBACK_ZOOM };
		if (!browser) return Promise.resolve(fallback);
		// Hash wins over geolocation when present — shareable view URLs are explicit.
		const parsed = decodeHash(window.location.hash);
		if (parsed.view) {
			return Promise.resolve({
				center: [parsed.view.lon, parsed.view.lat],
				zoom: parsed.view.zoom,
			});
		}
		if (!('geolocation' in navigator)) return Promise.resolve(fallback);
		return new Promise((resolve) => {
			navigator.geolocation.getCurrentPosition(
				(pos) => resolve({ center: [pos.coords.longitude, pos.coords.latitude], zoom: FALLBACK_ZOOM }),
				() => resolve(fallback),
				{ timeout: 4000, maximumAge: 60_000 },
			);
		});
	}

	const BASEMAP_SOURCE_ID = 'darkmap-basemap-src';
	const BASEMAP_LAYER_ID = 'darkmap-basemap-lyr';

	function applyBasemap(map: import('maplibre-gl').Map, id: string): void {
		const bm = basemapById(id);
		if (map.getLayer(BASEMAP_LAYER_ID)) map.removeLayer(BASEMAP_LAYER_ID);
		if (map.getSource(BASEMAP_SOURCE_ID)) map.removeSource(BASEMAP_SOURCE_ID);
		map.addSource(BASEMAP_SOURCE_ID, {
			type: 'raster',
			tiles: [...bm.tiles],
			tileSize: 256,
			attribution: bm.attribution,
			maxzoom: bm.maxZoom,
		});
		// Insert below any active raster overlays so they remain on top.
		const firstOverlay = LAYERS.map((l) => layerIdFor(l)).find((id) => map.getLayer(id));
		map.addLayer({ id: BASEMAP_LAYER_ID, type: 'raster', source: BASEMAP_SOURCE_ID }, firstOverlay);
	}

	function onBasemapChange(id: string): void {
		if (id === activeBasemap || !BASEMAPS.some((b) => b.id === id)) return;
		activeBasemap = id;
		if (mapInstance) applyBasemap(mapInstance, id);
		scheduleHashWrite();
	}

	onMount(async () => {
		if (!mapEl) return;
		const maplibre = await import('maplibre-gl');
		const { center, zoom } = await getInitialView();
		const bm = basemapById(activeBasemap);
		mapInstance = new maplibre.Map({
			container: mapEl,
			style: {
				version: 8,
				sources: {
					[BASEMAP_SOURCE_ID]: {
						type: 'raster',
						tiles: [...bm.tiles],
						tileSize: 256,
						attribution: bm.attribution,
						maxzoom: bm.maxZoom,
					},
				},
				layers: [{ id: BASEMAP_LAYER_ID, type: 'raster', source: BASEMAP_SOURCE_ID }],
			},
			center,
			zoom,
			attributionControl: false,
		});
		mapInstance.addControl(new maplibre.AttributionControl({ compact: true }), 'bottom-right');

		mapInstance.on('load', () => {
			if (!mapInstance) return;
			for (const layer of LAYERS) {
				if (layerState[layer.id]?.on) addLayerToMap(mapInstance, layer);
			}
		});

		// Persist view state in the hash on every pan/zoom (debounced).
		// Also keep `viewCenter` in sync so the ephemeris overlay can
		// recompute against the on-screen center.
		const syncCenter = () => {
			if (!mapInstance) return;
			const c = mapInstance.getCenter();
			viewCenter = { lat: c.lat, lon: c.lng };
			const b = mapInstance.getBounds();
			viewBounds = {
				north: b.getNorth(),
				south: b.getSouth(),
				east: b.getEast(),
				west: b.getWest(),
			};
		};
		syncCenter();
		mapInstance.on('moveend', () => {
			syncCenter();
			scheduleHashWrite();
		});
		mapInstance.on('zoomend', scheduleHashWrite);

		// If the hash includes `&et=`, restore the overlay open on load.
		if (decodeHash(window.location.hash).time) ephemerisOpen = true;

		// If the hash includes `&t=YYYY-MM`, mount the monthly layer once
		// the basemap + main layers are settled.
		if (monthlyOpen && monthlyMonth) void mountMonthly(monthlyMonth);

		// Point readout: click anywhere on the map.
		mapInstance.on('click', (ev) => {
			void queryAt(ev.lngLat.lat, ev.lngLat.lng);
		});

		// Tile / source failures: surface them in the toast so users see why
		// a layer is blank. MapLibre emits this for any source that returns
		// non-OK or fails to parse. We filter to raster sources we own.
		mapInstance.on('error', (ev) => {
			const sourceId = (ev as { sourceId?: string }).sourceId ?? (ev as { source?: { id?: string } }).source?.id;
			const err = (ev as { error?: { message?: string } }).error;
			if (!err) return;
			// Ignore basemap tile errors (those are upstream-of-upstream).
			if (sourceId === BASEMAP_SOURCE_ID) return;
			pushToast(err.message ?? 'tile load failed', sourceId);
		});
	});

	onDestroy(() => {
		clearTimeout(hashWriteTimer);
		mapInstance?.remove();
		mapInstance = undefined;
	});
</script>

<svelte:head>
	<title>darkmap.tinyland.dev</title>
	<meta
		name="description"
		content="Ad-free reimplementation of lightpollutionmap.info — VIIRS, Falchi 2016 World Atlas, SQM."
	/>
	<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css" />
</svelte:head>

<div bind:this={mapEl} class="map" aria-label="Light pollution map"></div>

<MapErrorToast errors={toastErrors} onDismiss={dismissToast} />

<GeocoderSearch
	bias={viewCenter}
	onSelect={(sel) => {
		if (!mapInstance) return;
		mapInstance.flyTo({ center: [sel.lon, sel.lat], zoom: Math.max(11, mapInstance.getZoom()), essential: true });
	}}
/>
<LayerRail
	layers={LAYERS}
	states={layerState}
	onchange={onChange}
	basemap={activeBasemap}
	onbasemapchange={onBasemapChange}
/>

{#if ephemerisOpen}
	<SkyCompass location={viewCenter} time={ephemerisTime} />
	<div style:--gantt-bottom-rem={monthlyOpen ? '6.5rem' : '1rem'} style:display="contents">
		<EphemerisGantt
			location={viewCenter}
			time={ephemerisTime}
			bounds={viewBounds}
			onTimeChange={(t) => {
				ephemerisTime = t;
				scheduleHashWrite();
			}}
		/>
	</div>
{/if}

<button
	class="ephemeris-toggle"
	type="button"
	aria-pressed={ephemerisOpen}
	onclick={() => {
		ephemerisOpen = !ephemerisOpen;
		if (ephemerisOpen && !decodeHash(window.location.hash).time) {
			ephemerisTime = new Date();
		}
		scheduleHashWrite();
	}}
	title="Toggle twilight strip"
>
	☼/☾
</button>

<button
	class="monthly-toggle"
	type="button"
	aria-pressed={monthlyOpen}
	onclick={onMonthlyToggle}
	title="Toggle VIIRS monthly time slider"
>
	⏱
</button>

{#if monthlyOpen && monthlyMonth}
	<TimeDock
		month={monthlyMonth}
		autoplay={monthlyAutoplay}
		onMonthChange={onMonthlyChange}
		onAutoplayChange={onMonthlyAutoplayChange}
		onClose={onMonthlyToggle}
	/>
{/if}

{#if readout}
	<PointReadout
		lat={readout.lat}
		lon={readout.lon}
		data={readout.data}
		loading={readout.loading}
		error={readout.error}
		onclose={() => (readout = undefined)}
	/>
{/if}

<footer class="attribution">
	<a href="/docs">credits + sources</a>
</footer>

<style>
	:global(html),
	:global(body) {
		margin: 0;
		padding: 0;
		height: 100%;
		background: #06080d;
		color: #e9ecf3;
		font-family: var(--font-sans, system-ui, sans-serif);
	}
	.map {
		position: fixed;
		inset: 0;
	}
	.attribution {
		position: absolute;
		bottom: 0.5rem;
		left: 1rem;
		font-size: 0.7rem;
		color: rgba(233, 236, 243, 0.65);
		background: rgba(8, 10, 16, 0.75);
		padding: 0.35rem 0.65rem;
		border-radius: 4px;
		z-index: 5;
	}
	.attribution a {
		color: #ffd166;
	}
	.ephemeris-toggle {
		position: fixed;
		right: 0.75rem;
		bottom: 0.75rem;
		z-index: 7;
		background: rgba(8, 10, 16, 0.85);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 999px;
		padding: 0.4rem 0.75rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.75rem;
		cursor: pointer;
		backdrop-filter: blur(6px);
	}
	.ephemeris-toggle:hover {
		border-color: rgba(255, 209, 102, 0.65);
		color: #ffd166;
	}
	.ephemeris-toggle[aria-pressed='true'] {
		color: #ffd166;
		border-color: rgba(255, 209, 102, 0.65);
	}
	.monthly-toggle {
		position: fixed;
		right: 0.75rem;
		bottom: 3.25rem;
		z-index: 7;
		background: rgba(8, 10, 16, 0.85);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 999px;
		padding: 0.4rem 0.7rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85rem;
		cursor: pointer;
		backdrop-filter: blur(6px);
	}
	.monthly-toggle:hover {
		border-color: rgba(255, 209, 102, 0.65);
		color: #ffd166;
	}
	.monthly-toggle[aria-pressed='true'] {
		color: #ffd166;
		border-color: rgba(255, 209, 102, 0.65);
	}
</style>
