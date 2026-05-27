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
	import { RouteImportService, RouteImportServiceLive, type ImportedRoute } from '$lib/routes/RouteImportService';

	// Inline GeoJSON shape — no @types/geojson in deps, and we only need the
	// minimal Feature/FeatureCollection structure that MapLibre consumes.
	type RouteGeoJsonGeometry =
		| { type: 'LineString'; coordinates: number[][] }
		| { type: 'Point'; coordinates: number[] };
	type RouteGeoJsonFeature = {
		type: 'Feature';
		properties: Record<string, unknown>;
		geometry: RouteGeoJsonGeometry;
	};
	type RouteGeoJsonFC = { type: 'FeatureCollection'; features: RouteGeoJsonFeature[] };
	import { LocateFixed, SunMoon, Upload, X } from '@lucide/svelte';
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

	// Route import (#104) — accepts KML / GPX / GeoJSON via file picker or drop
	// zone, parses with RouteImportService (all local, no upload), and renders
	// the resulting ImportedRoute as a MapLibre source + 2 layers (line for
	// segments, circle for waypoints).
	const ROUTE_SOURCE_ID = 'darkmap-route-import-src';
	const ROUTE_LINE_LAYER_ID = 'darkmap-route-import-line';
	const ROUTE_POINTS_LAYER_ID = 'darkmap-route-import-points';
	let currentRoute = $state<ImportedRoute | null>(null);
	let routeFileInput: HTMLInputElement | undefined;
	let dragOver = $state(false);

	function importedRouteToGeoJson(route: ImportedRoute): RouteGeoJsonFC {
		const features: RouteGeoJsonFeature[] = [];
		for (const segment of route.segments) {
			if (segment.points.length < 2) continue;
			features.push({
				type: 'Feature',
				properties: { kind: 'segment', name: segment.name ?? route.name },
				geometry: {
					type: 'LineString',
					coordinates: segment.points.map((p) => (p.eleM !== undefined ? [p.lon, p.lat, p.eleM] : [p.lon, p.lat])),
				},
			});
		}
		for (const waypoint of route.waypoints) {
			features.push({
				type: 'Feature',
				properties: { kind: 'waypoint', name: waypoint.name ?? null },
				geometry: {
					type: 'Point',
					coordinates:
						waypoint.eleM !== undefined ? [waypoint.lon, waypoint.lat, waypoint.eleM] : [waypoint.lon, waypoint.lat],
				},
			});
		}
		return { type: 'FeatureCollection', features };
	}

	function mountRoute(route: ImportedRoute): void {
		if (!mapInstance) return;
		const data = importedRouteToGeoJson(route);
		const existing = mapInstance.getSource(ROUTE_SOURCE_ID) as import('maplibre-gl').GeoJSONSource | undefined;
		if (existing) {
			existing.setData(data);
		} else {
			mapInstance.addSource(ROUTE_SOURCE_ID, { type: 'geojson', data });
			mapInstance.addLayer({
				id: ROUTE_LINE_LAYER_ID,
				type: 'line',
				source: ROUTE_SOURCE_ID,
				filter: ['==', ['get', 'kind'], 'segment'],
				layout: { 'line-join': 'round', 'line-cap': 'round' },
				paint: {
					'line-color': '#5ee2d0',
					'line-width': 3,
					'line-opacity': 0.85,
				},
			});
			mapInstance.addLayer({
				id: ROUTE_POINTS_LAYER_ID,
				type: 'circle',
				source: ROUTE_SOURCE_ID,
				filter: ['==', ['get', 'kind'], 'waypoint'],
				paint: {
					'circle-radius': 5,
					'circle-color': '#5ee2d0',
					'circle-stroke-color': '#06080d',
					'circle-stroke-width': 1.5,
				},
			});
		}
		// Fit the map to the imported bounds, with padding for the rail/toolbar.
		mapInstance.fitBounds(
			[
				[route.bounds.minLon, route.bounds.minLat],
				[route.bounds.maxLon, route.bounds.maxLat],
			],
			{ padding: { top: 60, bottom: 160, left: 40, right: 80 }, duration: 800, maxZoom: 14 },
		);
	}

	function clearRoute(): void {
		currentRoute = null;
		if (!mapInstance) return;
		if (mapInstance.getLayer(ROUTE_POINTS_LAYER_ID)) mapInstance.removeLayer(ROUTE_POINTS_LAYER_ID);
		if (mapInstance.getLayer(ROUTE_LINE_LAYER_ID)) mapInstance.removeLayer(ROUTE_LINE_LAYER_ID);
		if (mapInstance.getSource(ROUTE_SOURCE_ID)) mapInstance.removeSource(ROUTE_SOURCE_ID);
		if (routeFileInput) routeFileInput.value = '';
	}

	async function ingestRouteFile(file: File): Promise<void> {
		const body = await file.text();
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* RouteImportService;
				return yield* svc.parse({ body, sourceName: file.name, contentType: file.type || undefined });
			}).pipe(Effect.provide(RouteImportServiceLive)),
		);
		if (exit._tag === 'Failure') {
			const err = (exit.cause as unknown as { error?: { reason?: string; message?: string } }).error;
			pushToast(err?.message ?? 'Route import failed', 'route');
			return;
		}
		currentRoute = exit.value;
		mountRoute(exit.value);
		const km = exit.value.distanceM / 1000;
		const kmStr = km >= 1 ? `${km.toFixed(1)} km` : `${exit.value.distanceM.toFixed(0)} m`;
		pushToast(`Loaded ${exit.value.name} — ${exit.value.pointCount} points, ${kmStr}`, 'route');
	}

	function onRouteFileChange(ev: Event): void {
		const input = ev.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (file) void ingestRouteFile(file);
	}

	function triggerRoutePicker(): void {
		if (currentRoute) {
			clearRoute();
			return;
		}
		routeFileInput?.click();
	}

	function onMapDragOver(ev: DragEvent): void {
		// Only react when dragging files. Without this the browser's default
		// open-in-tab behavior fires on drop.
		if (!ev.dataTransfer?.types.includes('Files')) return;
		ev.preventDefault();
		dragOver = true;
	}

	function onMapDragLeave(): void {
		dragOver = false;
	}

	function onMapDrop(ev: DragEvent): void {
		if (!ev.dataTransfer?.files.length) return;
		ev.preventDefault();
		dragOver = false;
		const file = ev.dataTransfer.files[0];
		void ingestRouteFile(file);
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
		clearRoute();
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

<div
	bind:this={mapEl}
	class="map"
	class:drag-over={dragOver}
	role="application"
	aria-label="Light pollution map"
	ondragover={onMapDragOver}
	ondragleave={onMapDragLeave}
	ondrop={onMapDrop}
></div>

{#if dragOver}
	<div class="drop-hint" aria-hidden="true">Drop a KML, GPX, or GeoJSON file to import</div>
{/if}

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
			icon: SunMoon,
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
			icon: LocateFixed,
			title: followButtonLabel(),
			pressed: followStatus !== 'off',
			onclick: toggleFollow,
		},
		{
			id: 'route',
			label: currentRoute ? `Clear imported route (${currentRoute.name})` : 'Import KML / GPX / GeoJSON route',
			icon: currentRoute ? X : Upload,
			title: currentRoute ? `Clear ${currentRoute.name}` : 'Import KML / GPX / GeoJSON route',
			pressed: currentRoute !== null,
			onclick: triggerRoutePicker,
		},
	]}
/>

<input
	bind:this={routeFileInput}
	type="file"
	accept=".kml,.gpx,.geojson,.json,application/gpx+xml,application/vnd.google-earth.kml+xml,application/geo+json,application/json"
	style="display: none"
	onchange={onRouteFileChange}
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
	.map.drag-over {
		outline: 3px dashed rgba(94, 226, 208, 0.7);
		outline-offset: -6px;
	}
	.drop-hint {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		padding: 1rem 1.5rem;
		background: rgba(8, 10, 16, 0.92);
		color: #5ee2d0;
		border: 1px solid rgba(94, 226, 208, 0.5);
		border-radius: 8px;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.95rem;
		z-index: 100;
		pointer-events: none;
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
