<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { basemapById, BASEMAPS, DEFAULT_BASEMAP_ID } from '$lib/basemaps';
	import LayerRail, { type LayerState } from '$lib/components/LayerRail.svelte';
	import PointReadout, { type ReadoutData } from '$lib/components/PointReadout.svelte';
	import {
		FALLBACK_CENTER,
		FALLBACK_ZOOM,
		LAYERS,
		rasterUrlTemplate,
		VIIRS_YEARS,
		type RasterLayerDef,
	} from '$lib/layers';
	import { decodeHash, encodeHash } from '$lib/url-hash';

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
		mapInstance.on('moveend', scheduleHashWrite);
		mapInstance.on('zoomend', scheduleHashWrite);

		// Point readout: click anywhere on the map.
		mapInstance.on('click', (ev) => {
			void queryAt(ev.lngLat.lat, ev.lngLat.lng);
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
<LayerRail
	layers={LAYERS}
	states={layerState}
	onchange={onChange}
	basemap={activeBasemap}
	onbasemapchange={onBasemapChange}
/>

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
	Data © Jurij Stare,
	<a href="https://www.lightpollutionmap.info">lightpollutionmap.info</a>
	— NASA VIIRS DNB · Falchi et al. 2016
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
</style>
