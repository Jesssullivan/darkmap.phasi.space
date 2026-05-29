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
	import { AtmosphericPointService, AtmosphericPointServiceLive } from '$lib/effect/services/AtmosphericPointService';
	import { OpenAQService, OpenAQServiceLive, type OpenAQSensorCollection } from '$lib/effect/services/OpenAQService';
	import {
		TransmissionEstimator,
		TransmissionEstimatorLive,
		type TransmissionCurve,
	} from '$lib/effect/services/TransmissionEstimator';
	import { MieScatteringServiceLive } from '$lib/effect/services/MieScatteringService';
	import { LineByLineService, LineByLineServiceLive, type BandCurve } from '$lib/effect/services/LineByLineService';
	import { layerHealth } from '$lib/layers/HealthRegistry.svelte';
	import { parseLayerIdFromSourceId } from '$lib/layers/source-id';
	import { applyBasemapTimed, BASEMAP_LAYER_ID, BASEMAP_SOURCE_ID } from '$lib/map/BasemapController';
	import { pm25CircleColorExpression, pm25HeatmapWeightExpression } from '$lib/map/pm25-style';
	import type { AerosolType } from '$lib/spectral/aerosol-types';
	import TransmissionSheet from '$lib/components/TransmissionSheet.svelte';

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
	import { LayerErrorDebouncer } from '$lib/layers/toast-bridge';
	import { ATMO_PROTOCOL, atmosphericTileTemplate, makeAtmosphericTileLoader } from '$lib/map/atmosphericTileProtocol';
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
	let viewZoom = $state(FALLBACK_ZOOM);

	let toastErrors = $state<ToastErr[]>([]);
	let toastIdSeed = 0;
	function pushToast(text: string, source?: string): void {
		const id = ++toastIdSeed;
		toastErrors = [...toastErrors, { id, text, source }];
	}
	function dismissToast(id: number): void {
		toastErrors = toastErrors.filter((e) => e.id !== id);
	}

	// #236 — layer-error toast bridge. MapLibre `error` events used to push a
	// toast for every tile failure, including the noisy retry bursts CDNs emit
	// during a transient 5xx. The debouncer coalesces same-layer errors within
	// 500 ms into a single, data-driven toast text from `reasonForLayer`.
	const layerErrorBridge = new LayerErrorDebouncer((payload) => pushToast(payload.text, payload.source));

	type Readout = { lat: number; lon: number; data?: ReadoutData; loading: boolean; error?: string };
	let readout: Readout | undefined = $state();

	// Transmission widget state (PR-H). Opened via the (i) chevron on any
	// atmospheric LayerRail row. Inputs derived from the most recent
	// PointReadout when available + defaults for PWV / AOD / Ångström / O₃ /
	// zenith. AOD pixel sampling lands in a follow-up; PR-H uses a sensible
	// default (0.15) and shows it in the readout so users know it's not measured.
	let transmissionOpen = $state(false);
	let transmissionCurve = $state<TransmissionCurve | undefined>(undefined);
	let transmissionLoading = $state(false);
	let transmissionError = $state<string | undefined>(undefined);
	// V2-D inputs the user adjusts from the widget. Null aerosol type keeps
	// the LUT-only analytical path; any value switches on the live Mie blend.
	let transmissionAerosolType = $state<AerosolType | null>(null);
	let transmissionAod = $state(0.15);
	let transmissionAngstrom = $state(1.4);
	let transmissionRecomputeTimer: ReturnType<typeof setTimeout> | undefined;

	async function refreshTransmission(): Promise<void> {
		const pwv = readout?.data?.atmospheric?.pwv ?? 15;
		const input = {
			pwvMm: pwv,
			aod550: transmissionAod,
			angstrom: transmissionAngstrom,
			o3Du: 350,
			zenithDeg: 30,
		};
		transmissionLoading = true;
		transmissionError = undefined;
		const aerosolType = transmissionAerosolType;
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* TransmissionEstimator;
				return aerosolType !== null
					? yield* svc.estimateWithLiveAerosol(input, aerosolType)
					: yield* svc.estimate(input);
			}).pipe(Effect.provide(Layer.merge(TransmissionEstimatorLive, MieScatteringServiceLive))),
		);
		transmissionLoading = false;
		if (exit._tag === 'Success') {
			transmissionCurve = exit.value;
		} else {
			transmissionError = 'Transmission LUT unavailable';
		}
	}

	/** Debounced recompute used by the slider / picker callbacks. */
	function scheduleTransmissionRefresh(): void {
		clearTimeout(transmissionRecomputeTimer);
		transmissionRecomputeTimer = setTimeout(() => void refreshTransmission(), 80);
	}

	function onTransmissionInfo(_layerId: string): void {
		transmissionOpen = true;
		void refreshTransmission();
	}

	function onAerosolTypeChange(value: AerosolType | null): void {
		transmissionAerosolType = value;
		scheduleTransmissionRefresh();
	}
	function onAodChange(value: number): void {
		transmissionAod = value;
		scheduleTransmissionRefresh();
	}
	function onAngstromChange(value: number): void {
		transmissionAngstrom = value;
		scheduleTransmissionRefresh();
	}

	// V3b-4 — selected-band state + lazy LBL fetch.
	let transmissionBandId = $state<string | null>(null);
	let transmissionBandCurve = $state<BandCurve | undefined>(undefined);
	let transmissionBandLoading = $state(false);
	let transmissionBandError = $state<string | undefined>(undefined);

	async function onBandSelect(bandId: string | null): Promise<void> {
		transmissionBandId = bandId;
		transmissionBandError = undefined;
		if (bandId === null) {
			transmissionBandCurve = undefined;
			return;
		}
		transmissionBandLoading = true;
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* LineByLineService;
				return yield* svc.estimateInBand({ bandId, airmass: 1 });
			}).pipe(Effect.provide(LineByLineServiceLive)),
		);
		transmissionBandLoading = false;
		if (exit._tag === 'Success') {
			transmissionBandCurve = exit.value;
		} else {
			transmissionBandError = 'Line-by-line bake unavailable for this band';
			transmissionBandCurve = undefined;
		}
	}

	function closeTransmission(): void {
		transmissionOpen = false;
		transmissionBandId = null;
		transmissionBandCurve = undefined;
	}

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

		const featureinfoPromise = (async (): Promise<ReadoutData> => {
			const params = new URLSearchParams({ layer: activeViirs, lat: String(lat), lon: String(lon) });
			const res = await fetch(`/api/featureinfo?${params}`);
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			return (await res.json()) as ReadoutData;
		})();

		// Atmospheric reading rides through the AtmosphericPointService Effect
		// service so error reporting stays tagged. A failure here doesn't sink
		// the whole readout — we still want VIIRS / World Atlas values to land.
		const atmosphericPromise = Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* AtmosphericPointService;
				return yield* svc.getReading({ lat, lon, time: ephemerisTime });
			}).pipe(Effect.provide(AtmosphericPointServiceLive)),
		);

		try {
			const [featureinfo, atmosphericExit] = await Promise.all([featureinfoPromise, atmosphericPromise]);
			const data: ReadoutData =
				atmosphericExit._tag === 'Success' ? { ...featureinfo, atmospheric: atmosphericExit.value } : featureinfo;
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
		if (l.pointSourceUrl) {
			void mountPointLayer(l);
			return;
		}
		// #248 — atmospheric tiles route through our custom protocol so the
		// loader can read the no-data/error outcome header and own the health
		// state. They start in `loading`; the loader flips to ok/empty/error.
		const atmospheric = l.group === 'atmospheric';
		if (atmospheric) layerHealth.dispatch(l.id, { type: 'mount' });
		void runController(
			Effect.flatMap(MapLayerController, (c) =>
				c.mount({
					id: l.id,
					tileUrlTemplate: atmospheric ? atmosphericTileTemplate(l.id) : rasterUrlTemplate(l.id),
					opacity: layerState[l.id]?.opacity ?? l.opacity,
					...(l.maxNativeZoom !== undefined ? { maxZoom: l.maxNativeZoom } : {}),
					...(l.attribution ? { attribution: l.attribution } : {}),
				}),
			),
		);
	}

	function unmountLayer(l: RasterLayerDef): void {
		if (l.pointSourceUrl) {
			unmountPointLayer(l);
			return;
		}
		// Clear the atmospheric health pill back to idle on toggle-off.
		if (l.group === 'atmospheric') layerHealth.dispatch(l.id, { type: 'unmount' });
		void runController(Effect.flatMap(MapLayerController, (c) => c.unmount(l.id)));
	}

	function setLayerOpacity(l: RasterLayerDef, op: number): void {
		if (l.pointSourceUrl) {
			setPointLayerOpacity(l, op);
			return;
		}
		void runController(Effect.flatMap(MapLayerController, (c) => c.setOpacity(l.id, op)));
	}

	// ----- Point-source overlays (OpenAQ smog, future PurpleAir / AirNow) -----
	//
	// MapLibre renders station-observation density, not physical diffusion; null
	// PM2.5 readings are unknown and excluded from heatmap weight. Below a
	// 5-feature density threshold, the heatmap looks empty, so circle markers
	// carry the sparse-coverage UX (PR-F). All point overlays bucket through
	// `darkmap-atmospheric-tile` via the SW route.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping for the moveend handler, not reactive state
	const POINT_SOURCE_IDS = new Set<string>();
	let pointFetchInflight: AbortController | undefined;
	let pointMoveendDebounce: ReturnType<typeof setTimeout> | undefined;

	const pointSourceId = (id: string) => `darkmap-${id}-pt-src`;
	const pointHeatmapId = (id: string) => `darkmap-${id}-pt-heat`;
	const pointCircleId = (id: string) => `darkmap-${id}-pt-circ`;

	async function mountPointLayer(l: RasterLayerDef): Promise<void> {
		if (!mapInstance || !l.pointSourceUrl) return;
		const map = mapInstance;
		if (!map.isStyleLoaded()) {
			await new Promise<void>((resolve) => map.once('style.load', () => resolve()));
		}

		const srcId = pointSourceId(l.id);
		const heatId = pointHeatmapId(l.id);
		const circId = pointCircleId(l.id);
		const opacity = layerState[l.id]?.opacity ?? l.opacity;

		if (!map.getSource(srcId)) {
			map.addSource(srcId, {
				type: 'geojson',
				data: { type: 'FeatureCollection', features: [] },
				...(l.attribution ? { attribution: l.attribution } : {}),
			});
		}
		if (!map.getLayer(heatId)) {
			map.addLayer({
				id: heatId,
				type: 'heatmap',
				source: srcId,
				paint: {
					'heatmap-weight': pm25HeatmapWeightExpression(),
					'heatmap-intensity': 1,
					'heatmap-radius': 30,
					'heatmap-opacity': opacity,
					'heatmap-color': [
						'interpolate',
						['linear'],
						['heatmap-density'],
						0,
						'rgba(0, 228, 0, 0)',
						0.12,
						'rgba(0, 228, 0, 0.55)',
						0.35,
						'rgba(255, 255, 0, 0.7)',
						0.55,
						'rgba(255, 126, 0, 0.78)',
						0.75,
						'rgba(255, 0, 0, 0.85)',
						1,
						'rgba(143, 63, 151, 0.9)',
					],
				},
			});
		}
		if (!map.getLayer(circId)) {
			map.addLayer({
				id: circId,
				type: 'circle',
				source: srcId,
				paint: {
					'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 12, 7],
					'circle-color': pm25CircleColorExpression(),
					'circle-opacity': opacity,
					'circle-stroke-width': 1,
					'circle-stroke-color': 'rgba(8, 10, 16, 0.85)',
				},
			});
		}

		POINT_SOURCE_IDS.add(l.id);
		await refreshPointLayer(l);
	}

	function unmountPointLayer(l: RasterLayerDef): void {
		if (!mapInstance) return;
		const map = mapInstance;
		const srcId = pointSourceId(l.id);
		const heatId = pointHeatmapId(l.id);
		const circId = pointCircleId(l.id);
		if (map.getLayer(heatId)) map.removeLayer(heatId);
		if (map.getLayer(circId)) map.removeLayer(circId);
		if (map.getSource(srcId)) map.removeSource(srcId);
		POINT_SOURCE_IDS.delete(l.id);
	}

	function setPointLayerOpacity(l: RasterLayerDef, op: number): void {
		if (!mapInstance) return;
		const map = mapInstance;
		const heatId = pointHeatmapId(l.id);
		const circId = pointCircleId(l.id);
		if (map.getLayer(heatId)) map.setPaintProperty(heatId, 'heatmap-opacity', op);
		if (map.getLayer(circId)) map.setPaintProperty(circId, 'circle-opacity', op);
	}

	async function refreshPointLayer(l: RasterLayerDef): Promise<void> {
		if (!mapInstance || !l.pointSourceUrl) return;
		const map = mapInstance;
		const b = map.getBounds();
		const bbox = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };

		// Cancel any in-flight viewport fetch so we don't write stale data
		// after a fast pan. The Effect service doesn't carry an abort surface
		// (intentionally — we use this AbortController at the page seam).
		pointFetchInflight?.abort();
		pointFetchInflight = new AbortController();

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* OpenAQService;
				return yield* svc.getSensors(bbox);
			}).pipe(Effect.provide(OpenAQServiceLive)),
		);
		if (exit._tag !== 'Success') {
			// Soft-fail — keep whatever the previous data was; the proxy returns
			// degraded:true for missing keys so we won't normally enter here.
			layerHealth.dispatch(l.id, { type: 'tile-error', reason: 'fetch failed' });
			return;
		}
		const fc: OpenAQSensorCollection = exit.value;
		const src = map.getSource(pointSourceId(l.id));
		if (src && 'setData' in src && typeof src.setData === 'function') {
			(src as { setData: (data: OpenAQSensorCollection) => void }).setData(fc);
		}

		// Toggle heatmap visibility based on density — at < 5 features the
		// heatmap is visually empty, so show only the circles for clarity.
		const heatId = pointHeatmapId(l.id);
		if (map.getLayer(heatId)) {
			map.setLayoutProperty(heatId, 'visibility', fc.features.length >= 5 ? 'visible' : 'none');
		}

		// Health-state dispatch (#196). degraded:true means OPENAQ_API_KEY is
		// unset upstream or returned 401/403 — surface as 'no data' so users
		// know the overlay is intentionally blank rather than broken.
		if (fc.degraded === true) {
			layerHealth.dispatch(l.id, { type: 'tile-empty', reason: 'OpenAQ proxy degraded' });
		} else if (fc.features.length === 0) {
			layerHealth.dispatch(l.id, { type: 'tile-empty', reason: 'no sensors in viewport' });
		} else {
			layerHealth.dispatch(l.id, { type: 'tile-ok' });
		}
	}

	function schedulePointRefresh(): void {
		if (POINT_SOURCE_IDS.size === 0) return;
		clearTimeout(pointMoveendDebounce);
		pointMoveendDebounce = setTimeout(() => {
			for (const id of POINT_SOURCE_IDS) {
				const layer = LAYERS.find((l) => l.id === id);
				if (layer) void refreshPointLayer(layer);
			}
		}, 500);
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

	function applyBasemapLive(map: import('maplibre-gl').Map, id: string): void {
		const bm = basemapById(id);
		const elapsed = applyBasemapTimed(map, {
			tiles: bm.tiles,
			attribution: bm.attribution,
			maxZoom: bm.maxZoom,
		});
		// Mobile basemap-swap budget (#198). Anything over this hints at
		// jank — surface to dev console so QA can chase regressions.
		if (elapsed > 16) {
			console.debug(`basemap swap → ${id} took ${elapsed.toFixed(1)} ms`);
		}
		// #235 — basemaps participate in the per-layer health matrix. We
		// dispatch `mount` here; the MapLibre `sourcedata` handler flips
		// the state to `rendered` on the first tile, and `error` rewires
		// to a `tile-error` event keyed on the active basemap id.
		layerHealth.dispatch(id, { type: 'mount' });
	}

	function onBasemapChange(id: string): void {
		if (id === activeBasemap || !BASEMAPS.some((b) => b.id === id)) return;
		// Dispose health observability for the basemap we're leaving so the
		// LayerRail pill drops back to idle for the inactive entry.
		layerHealth.dispatch(activeBasemap, { type: 'unmount' });
		activeBasemap = id;
		if (mapInstance) applyBasemapLive(mapInstance, id);
		scheduleHashWrite();
	}

	onMount(async () => {
		if (!mapEl) return;
		const maplibre = await import('maplibre-gl');
		maplibreLib = maplibre;
		// #248 — register the atmospheric tile protocol so GIBS tiles fetch
		// through our loader, which reads the no-data/error outcome header and
		// drives the LayerRail health pill. Must be registered before any
		// atmospheric source is added (mount happens on toggle, post-init).
		maplibre.addProtocol(
			ATMO_PROTOCOL,
			makeAtmosphericTileLoader({
				fetchImpl: (input, init) => fetch(input, init),
				getHealth: (id) => layerHealth.getHealth(id),
				dispatch: (id, event) => layerHealth.dispatch(id, event),
			}),
		);
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
			viewZoom = mapInstance.getZoom();
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
			schedulePointRefresh();
		});
		mapInstance.on('zoomend', () => {
			syncCenter();
			scheduleHashWrite();
			schedulePointRefresh();
		});

		// Default the twilight strip open in the browser, while keeping SSR
		// stable so the client clock owns the initial ephemeris time.
		ephemerisOpen = true;

		mapInstance.on('click', (ev) => {
			void queryAt(ev.lngLat.lat, ev.lngLat.lng);
		});

		mapInstance.on('error', (ev) => {
			const sourceId = (ev as { sourceId?: string }).sourceId ?? (ev as { source?: { id?: string } }).source?.id;
			const err = (ev as { error?: { message?: string; status?: number } }).error;
			if (!err) return;
			// Basemap errors route to the active basemap id (#235). Toast is
			// suppressed because basemap failures are usually noisy retries
			// and the LayerRail pill carries the same information.
			if (sourceId === BASEMAP_SOURCE_ID) {
				layerHealth.dispatch(activeBasemap, {
					type: 'tile-error',
					reason: err.message ?? 'tile load failed',
					status: err.status,
				});
				return;
			}
			// #196 — dispatch a tile-error health event for the matching LAYERS row.
			// Helper skips point-source overlays (which use a -pt-src suffix and
			// dispatch health explicitly from refreshPointLayer).
			const layerId = parseLayerIdFromSourceId(sourceId);
			if (layerId) {
				// #248 — atmospheric layers own their health via the protocol
				// loader (which has the no-data/error outcome header). Don't
				// double-dispatch here; just surface the toast.
				const atmospheric = LAYERS.find((l) => l.id === layerId)?.group === 'atmospheric';
				if (!atmospheric) {
					layerHealth.dispatch(layerId, {
						type: 'tile-error',
						reason: err.message ?? 'tile load failed',
						status: err.status,
					});
				}
				// #236 — feed the debounced toast bridge instead of pushing the
				// raw upstream message inline. The bridge coalesces rapid bursts
				// of the same layer error and turns the upstream into a short,
				// user-readable reason from a data-driven table.
				layerErrorBridge.enqueue({ layerId, status: err.status, message: err.message });
			} else {
				// No matching layer id — fall back to the raw upstream message
				// (point-source overlays + unknown sources).
				pushToast(err.message ?? 'tile load failed', sourceId);
			}
		});

		// First successful tile load per source flips loading → rendered. The
		// `sourcedata` event fires repeatedly per tile; we just need one to
		// confirm the layer is alive.
		mapInstance.on('sourcedata', (ev) => {
			const evt = ev as {
				sourceId?: string;
				isSourceLoaded?: boolean;
				tile?: unknown;
			};
			if (evt.tile === undefined) return; // Style or attribution event, not a tile load.
			// Basemap source dispatches under the active basemap id (#235).
			if (evt.sourceId === BASEMAP_SOURCE_ID) {
				const current = layerHealth.getHealth(activeBasemap);
				if (current.tag === 'loading') {
					layerHealth.dispatch(activeBasemap, { type: 'tile-ok' });
				}
				// Cancel any pending error toast — the basemap recovered.
				layerErrorBridge.cancel(activeBasemap);
				return;
			}
			const layerId = parseLayerIdFromSourceId(evt.sourceId);
			if (!layerId) return;
			// #248 — atmospheric layers are owned by the protocol loader (it has
			// the no-data outcome header); a generic sourcedata tile-ok here would
			// wrongly flip a no-data layer to "live". Skip them.
			if (LAYERS.find((l) => l.id === layerId)?.group === 'atmospheric') return;
			const current = layerHealth.getHealth(layerId);
			if (current.tag === 'loading') {
				layerHealth.dispatch(layerId, { type: 'tile-ok' });
			}
			// A successful tile load means the prior error (if any) is moot.
			layerErrorBridge.cancel(layerId);
		});

		// Initial basemap mounts at map-init time; dispatch so the LayerRail
		// reflects the basemap lifecycle from frame 1.
		layerHealth.dispatch(activeBasemap, { type: 'mount' });
	});

	onDestroy(() => {
		clearTimeout(hashWriteTimer);
		stopFollow();
		clearRoute();
		layerErrorBridge.dispose();
		// #248 — unregister the atmospheric protocol so a re-mount (HMR / SPA
		// nav) doesn't throw "Protocol already added".
		try {
			maplibreLib?.removeProtocol(ATMO_PROTOCOL);
		} catch {
			// not registered (SSR / early teardown) — ignore.
		}
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
	time={ephemerisTime}
	oninfo={onTransmissionInfo}
/>
{#if transmissionOpen}
	<TransmissionSheet
		curve={transmissionCurve}
		loading={transmissionLoading}
		error={transmissionError}
		onclose={closeTransmission}
		aerosolType={transmissionAerosolType}
		aod={transmissionAod}
		angstrom={transmissionAngstrom}
		{onAerosolTypeChange}
		{onAodChange}
		{onAngstromChange}
		selectedBandId={transmissionBandId}
		bandCurve={transmissionBandCurve}
		bandLoading={transmissionBandLoading}
		bandError={transmissionBandError}
		{onBandSelect}
	/>
{/if}

{#if ephemerisOpen}
	<SkyCompass location={viewCenter} time={ephemerisTime} />
	<EphemerisGantt
		location={viewCenter}
		time={ephemerisTime}
		bounds={viewBounds}
		zoom={viewZoom}
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
			bottom: calc(var(--field-bottom-reserve, 7.75rem) + env(safe-area-inset-bottom, 0px) + 6.25rem);
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
