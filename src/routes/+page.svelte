<script lang="ts">
	import { Effect, Layer } from 'effect';
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { basemapById, BASEMAPS, DEFAULT_BASEMAP_ID } from '$lib/basemaps';
	import {
		classifyPositionFreshness,
		GeolocationService,
		makeGeolocationServiceLive,
		type DevicePosition,
		type GeolocationWatch,
	} from '$lib/device/GeolocationService';
	import EphemerisGantt from '$lib/components/EphemerisGantt.svelte';
	import GeocoderSearch from '$lib/components/GeocoderSearch.svelte';
	import LayerRail, { type LayerState } from '$lib/components/LayerRail.svelte';
	import MapErrorToast, { type ToastErr } from '$lib/components/MapErrorToast.svelte';
	import MapToolbar from '$lib/components/MapToolbar.svelte';
	import PointReadout, { type ReadoutData } from '$lib/components/PointReadout.svelte';
	import SkyCompass from '$lib/components/SkyCompass.svelte';
	import {
		FALLBACK_CENTER,
		FALLBACK_ZOOM,
		LAYERS,
		rasterUrlTemplate,
		VIIRS_YEARS,
		type RasterLayerDef,
	} from '$lib/layers';
	import { makeMapLayerControllerLive, MapLayerController, type MapLayerError } from '$lib/map/MapLayerController';
	import { decodeHash, encodeHash } from '$lib/url-hash';

	let mapEl: HTMLDivElement | undefined = $state();
	let mapInstance: import('maplibre-gl').Map | undefined;
	let controllerLayer: Layer.Layer<MapLayerController> | undefined;

	const initialState = (): Record<string, LayerState> => {
		const defaults: Record<string, LayerState> = Object.fromEntries(
			LAYERS.map((l) => [l.id, { on: l.defaultEnabled, opacity: l.opacity }]),
		);
		if (!browser) return defaults;
		const parsed = decodeHash(window.location.hash);
		if (!parsed.layers) return defaults;
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

	let toastErrors = $state<ToastErr[]>([]);
	let toastIdSeed = 0;
	function pushToast(text: string, source?: string): void {
		const id = ++toastIdSeed;
		toastErrors = [...toastErrors, { id, text, source }];
	}
	function dismissToast(id: number): void {
		toastErrors = toastErrors.filter((e) => e.id !== id);
	}

	type Readout = { lat: number; lon: number; data?: ReadoutData; loading: boolean; error?: string };
	let readout: Readout | undefined = $state();

	// GPS follow-mode state (#124). Service stays in lib/device; this is just
	// the page-side lifecycle: a toolbar toggle starts watchPosition, drops
	// a marker on the map, recenters on first fix, and shows live/stale state.
	type FollowStatus = 'off' | 'requesting' | 'live' | 'stale' | 'denied' | 'unavailable' | 'error';
	let followStatus = $state<FollowStatus>('off');
	let followPosition = $state<DevicePosition | null>(null);
	let followWatch: GeolocationWatch | undefined;
	let followMarker: import('maplibre-gl').Marker | undefined;
	let followMarkerEl: HTMLDivElement | undefined;
	let maplibreLib: typeof import('maplibre-gl') | undefined;
	let followStaleTimer: ReturnType<typeof setTimeout> | undefined;

	function followButtonLabel(): string {
		switch (followStatus) {
			case 'off':
				return 'Follow my location';
			case 'requesting':
				return 'Requesting location…';
			case 'live':
				return 'Following live location';
			case 'stale':
				return 'Following (stale fix)';
			case 'denied':
				return 'Location permission denied';
			case 'unavailable':
				return 'Location unavailable';
			case 'error':
				return 'Location error';
		}
	}

	function applyFollowMarker(position: DevicePosition): void {
		if (!mapInstance || !maplibreLib) return;
		const lngLat: [number, number] = [position.lon, position.lat];
		if (!followMarker || !followMarkerEl) {
			followMarkerEl = document.createElement('div');
			followMarkerEl.className = 'follow-marker';
			followMarker = new maplibreLib.Marker({ element: followMarkerEl, anchor: 'center' })
				.setLngLat(lngLat)
				.addTo(mapInstance);
		} else {
			followMarker.setLngLat(lngLat);
		}
		const acc = Number.isFinite(position.accuracyM) ? Math.round(position.accuracyM) : null;
		followMarkerEl.title = acc !== null ? `±${acc} m` : 'live position';
		followMarkerEl.dataset.freshness = position.freshness;
	}

	function removeFollowMarker(): void {
		followMarker?.remove();
		followMarker = undefined;
		followMarkerEl = undefined;
	}

	function scheduleStaleCheck(timestampMs: number): void {
		clearTimeout(followStaleTimer);
		// Re-run classifyPositionFreshness once the live → stale crossover hits.
		// classifyPositionFreshness flips at DEFAULT_STALE_AFTER_MS; align here.
		followStaleTimer = setTimeout(
			() => {
				if (followStatus !== 'live' || !followPosition) return;
				if (classifyPositionFreshness(timestampMs, Date.now()) === 'stale') {
					followStatus = 'stale';
					followPosition = { ...followPosition, freshness: 'stale' };
					if (followMarkerEl) followMarkerEl.dataset.freshness = 'stale';
				}
			},
			2 * 60_000 + 1_000,
		);
	}

	function stopFollow(): void {
		clearTimeout(followStaleTimer);
		followStaleTimer = undefined;
		followWatch?.stop();
		followWatch = undefined;
		removeFollowMarker();
		followPosition = null;
		followStatus = 'off';
	}

	async function startFollow(): Promise<void> {
		if (!mapInstance) return;
		if (!('geolocation' in navigator)) {
			followStatus = 'unavailable';
			pushToast('Location unavailable on this device.', 'follow');
			return;
		}
		followStatus = 'requesting';
		const layer = makeGeolocationServiceLive(navigator as { geolocation?: Geolocation });
		// One-shot getCurrentPosition gives the user immediate feedback while
		// watch settles. We center on whichever lands first.
		let centered = false;
		const centerOnce = (p: DevicePosition): void => {
			if (centered || !mapInstance) return;
			centered = true;
			mapInstance.easeTo({ center: [p.lon, p.lat], duration: 600 });
		};
		const watchExit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* GeolocationService;
				return yield* svc.watch(
					(update) => {
						if (update.kind === 'position') {
							followPosition = update.position;
							followStatus = update.position.freshness === 'stale' ? 'stale' : 'live';
							applyFollowMarker(update.position);
							centerOnce(update.position);
							scheduleStaleCheck(update.position.timestampMs);
						} else {
							handleFollowError(update.error);
						}
					},
					{ enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
				);
			}).pipe(Effect.provide(layer)),
		);
		if (watchExit._tag === 'Failure') {
			// Watch failed to start — usually unsupported. Pull the typed error.
			const err = (watchExit.cause as unknown as { error?: { reason?: string; message?: string } }).error;
			handleFollowError({
				reason: (err?.reason as 'unsupported') ?? 'failed',
				message: err?.message ?? 'follow could not start',
			});
			return;
		}
		followWatch = watchExit.value;
	}

	function handleFollowError(err: { reason: string; message: string }): void {
		switch (err.reason) {
			case 'denied':
				followStatus = 'denied';
				pushToast('Location permission denied. Enable in your browser settings to use follow mode.', 'follow');
				break;
			case 'unavailable':
				followStatus = 'unavailable';
				pushToast('Location unavailable right now.', 'follow');
				break;
			case 'unsupported':
				followStatus = 'unavailable';
				pushToast('Location unsupported in this browser.', 'follow');
				break;
			case 'timeout':
				followStatus = 'error';
				pushToast('Location request timed out. Try again with a clear view of the sky.', 'follow');
				break;
			default:
				followStatus = 'error';
				pushToast(err.message || 'Location error.', 'follow');
		}
		stopFollow();
	}

	function toggleFollow(): void {
		if (followStatus === 'off') void startFollow();
		else stopFollow();
	}

	async function queryAt(lat: number, lon: number): Promise<void> {
		const activeViirs = VIIRS_YEARS.find((l) => layerState[l.id]?.on)?.id ?? VIIRS_YEARS[0].id;
		readout = { lat, lon, loading: true };
		try {
			const params = new URLSearchParams({ layer: activeViirs, lat: String(lat), lon: String(lon) });
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
			});
			history.replaceState(null, '', hash || window.location.pathname);
		}, 250);
	}

	function runController<A>(eff: Effect.Effect<A, MapLayerError, MapLayerController>): Promise<A> | undefined {
		if (!controllerLayer) return undefined;
		return Effect.runPromise(
			eff.pipe(
				Effect.provide(controllerLayer),
				Effect.tapError((err) => Effect.sync(() => pushToast(`${err.op} ${err.id}: ${err.reason}`, err.id))),
			),
		);
	}

	function mountLayer(l: RasterLayerDef): void {
		void runController(
			Effect.flatMap(MapLayerController, (c) =>
				c.mount({
					id: l.id,
					tileUrlTemplate: rasterUrlTemplate(l.id),
					opacity: layerState[l.id]?.opacity ?? l.opacity,
				}),
			),
		);
	}

	function unmountLayer(l: RasterLayerDef): void {
		void runController(Effect.flatMap(MapLayerController, (c) => c.unmount(l.id)));
	}

	function setLayerOpacity(l: RasterLayerDef, op: number): void {
		void runController(Effect.flatMap(MapLayerController, (c) => c.setOpacity(l.id, op)));
	}

	function onChange(id: string, partial: Partial<LayerState>): void {
		const layer = LAYERS.find((l) => l.id === id);
		if (!layer) return;
		const prev = layerState[id] ?? { on: false, opacity: layer.opacity };
		const next = { ...prev, ...partial };
		layerState[id] = next;
		if (!mapInstance) return;
		if (partial.on !== undefined && partial.on !== prev.on) {
			if (next.on) mountLayer(layer);
			else unmountLayer(layer);
		}
		if (partial.opacity !== undefined && partial.opacity !== prev.opacity && next.on) {
			setLayerOpacity(layer, next.opacity);
		}
		scheduleHashWrite();
	}

	function getInitialView(): Promise<{ center: [number, number]; zoom: number }> {
		const fallback = { center: [...FALLBACK_CENTER] as [number, number], zoom: FALLBACK_ZOOM };
		if (!browser) return Promise.resolve(fallback);
		const parsed = decodeHash(window.location.hash);
		if (parsed.view) {
			return Promise.resolve({ center: [parsed.view.lon, parsed.view.lat], zoom: parsed.view.zoom });
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
		const firstOverlay = LAYERS.map((l) => `darkmap-${l.id}-lyr`).find((id) => map.getLayer(id));
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
		maplibreLib = maplibre;
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
		controllerLayer = makeMapLayerControllerLive(mapInstance);

		// Mount initial layers through the controller. The controller awaits
		// `style.load` internally, so we no longer race "Style is not done
		// loading" by reaching into addSource on a half-initialized map.
		for (const layer of LAYERS) {
			if (layerState[layer.id]?.on) mountLayer(layer);
		}

		const syncCenter = (): void => {
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

		// Default the twilight strip open in the browser, while keeping SSR
		// stable so the client clock owns the initial ephemeris time.
		ephemerisOpen = true;

		mapInstance.on('click', (ev) => {
			void queryAt(ev.lngLat.lat, ev.lngLat.lng);
		});

		mapInstance.on('error', (ev) => {
			const sourceId = (ev as { sourceId?: string }).sourceId ?? (ev as { source?: { id?: string } }).source?.id;
			const err = (ev as { error?: { message?: string } }).error;
			if (!err) return;
			if (sourceId === BASEMAP_SOURCE_ID) return;
			pushToast(err.message ?? 'tile load failed', sourceId);
		});
	});

	onDestroy(() => {
		clearTimeout(hashWriteTimer);
		stopFollow();
		mapInstance?.remove();
		mapInstance = undefined;
		controllerLayer = undefined;
		maplibreLib = undefined;
	});
</script>

<svelte:head>
	<title>darkmap</title>
	<meta
		name="description"
		content="Dark-sky planning map with VIIRS, Falchi 2016 World Atlas, terrain horizon, geocoder, and sun/moon timing."
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
	<EphemerisGantt
		location={viewCenter}
		time={ephemerisTime}
		bounds={viewBounds}
		onTimeChange={(t) => {
			ephemerisTime = t;
			scheduleHashWrite();
		}}
	/>
{/if}

<MapToolbar
	items={[
		{
			id: 'ephemeris',
			label: ephemerisOpen ? 'Hide twilight strip' : 'Show twilight strip',
			glyph: '☼/☾',
			title: ephemerisOpen ? 'Hide twilight strip' : 'Show twilight strip',
			pressed: ephemerisOpen,
			onclick: () => {
				ephemerisOpen = !ephemerisOpen;
				if (ephemerisOpen && !decodeHash(window.location.hash).time) {
					ephemerisTime = new Date();
				}
				scheduleHashWrite();
			},
		},
		{
			id: 'follow',
			label: followButtonLabel(),
			glyph: '◎',
			title: followButtonLabel(),
			pressed: followStatus !== 'off',
			onclick: toggleFollow,
		},
	]}
/>

{#if readout}
	<PointReadout
		lat={readout.lat}
		lon={readout.lon}
		time={ephemerisTime}
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
		bottom: calc(var(--field-bottom-reserve, 7.75rem) + env(safe-area-inset-bottom, 0px));
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
	@media (max-width: 820px) {
		.attribution {
			left: 0.75rem;
			bottom: calc(var(--field-bottom-reserve, 7.75rem) + env(safe-area-inset-bottom, 0px) + 0.5rem);
		}
	}
	:global(.follow-marker) {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: #ffd166;
		border: 2px solid rgba(8, 10, 16, 0.85);
		box-shadow: 0 0 0 6px rgba(255, 209, 102, 0.18);
		cursor: pointer;
	}
	:global(.follow-marker[data-freshness='stale']) {
		background: rgba(255, 209, 102, 0.55);
		box-shadow: 0 0 0 6px rgba(255, 209, 102, 0.08);
	}
	:global(.follow-marker)::after {
		content: '';
		position: absolute;
		inset: -4px;
		border-radius: 50%;
		border: 1px solid rgba(255, 209, 102, 0.55);
		animation: follow-pulse 2.4s ease-out infinite;
	}
	:global(.follow-marker[data-freshness='stale'])::after {
		animation: none;
		opacity: 0.4;
	}
	@keyframes follow-pulse {
		0% {
			transform: scale(0.9);
			opacity: 0.8;
		}
		100% {
			transform: scale(2.2);
			opacity: 0;
		}
	}
</style>
