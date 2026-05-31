<script lang="ts">
	import { Cause, Effect, Layer, Option } from 'effect';
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
	import {
		AirQualityService,
		AirQualityServiceLive,
		type AirQualityPointReading,
	} from '$lib/effect/services/AirQualityService';
	import { OpenAQService, OpenAQServiceLive, type OpenAQSensorCollection } from '$lib/effect/services/OpenAQService';
	import {
		TransmissionEstimator,
		TransmissionEstimatorLive,
		type TransmissionCurve,
	} from '$lib/effect/services/TransmissionEstimator';
	import { MieScatteringServiceLive } from '$lib/effect/services/MieScatteringService';
	import { LineByLineService, LineByLineServiceLive, type BandCurve } from '$lib/effect/services/LineByLineService';
	import {
		checkOcclusion,
		elevationToZenithDeg,
		lookAngleAirmass,
		normalizeAzimuthDeg,
	} from '$lib/transmission/slant-geometry';
	import type { LookTarget } from '$lib/transmission/look-angle';
	import { computePinEphemeris, type PinEphemerisReadout } from '$lib/ephemeris/pinEphemeris';
	import { beamCenterline, beamSamplePoints, beamSectorPolygon } from '$lib/map/beam-footprint';
	import { aggregatePath, type PathProfile } from '$lib/atmospheric/path-constituents';
	import { layerHealth } from '$lib/layers/HealthRegistry.svelte';
	import { parseLayerIdFromSourceId } from '$lib/layers/source-id';
	import { applyBasemapTimed, BASEMAP_LAYER_ID, BASEMAP_SOURCE_ID } from '$lib/map/BasemapController';
	import { pm25CircleColorExpression, pm25HeatmapWeightExpression } from '$lib/map/pm25-style';
	import { estimatePm25At, pm25ToAod550, type Pm25Estimate, type Pm25Station } from '$lib/atmospheric/pm25-diffusion';
	import { buildTxConstituents, toTransmissionInput, type TxConstituents } from '$lib/atmospheric/tx-constituents';
	import { columnOzoneDu } from '$lib/atmospheric/ozone-climatology';
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
	import { Compass, LocateFixed, SunMoon, Upload, X } from '@lucide/svelte';
	import Tour, { type TourStep } from '$lib/components/Tour.svelte';
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
		utcDayKey,
		VIIRS_YEARS,
		type RasterLayerDef,
	} from '$lib/layers';
	import { LayerErrorDebouncer } from '$lib/layers/toast-bridge';
	import { ATMO_PROTOCOL, atmosphericTileTemplate, makeAtmosphericTileLoader } from '$lib/map/atmosphericTileProtocol';
	import { PointMarkerController } from '$lib/map/point-marker';
	import { makeMapLayerControllerLive, MapLayerController, type MapLayerError } from '$lib/map/MapLayerController';
	import { decodeHash, encodeHash } from '$lib/url-hash';

	let mapEl: HTMLDivElement | undefined = $state();
	let mapInstance: import('maplibre-gl').Map | undefined;
	let controllerLayer: Layer.Layer<MapLayerController> | undefined;
	let pointMarker: PointMarkerController | undefined;

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

	// Guided tour — custom, no-dep. Spotlights the rail, the atmospheric overlays
	// + spectral widget, the click-to-readout map, and the twilight tools.
	// First-run auto-start (localStorage flag) + a replay button in the toolbar.
	let tourOpen = $state(false);
	const TOUR_FLAG = 'darkmap-tour-v1';
	// On coarse pointers the rail is a drawer — open it before spotlighting rail UI.
	const ensureRailOpen = (): void => {
		const toggle = document.querySelector<HTMLButtonElement>('[data-tour="rail-toggle"]');
		if (toggle && getComputedStyle(toggle).display !== 'none' && toggle.getAttribute('aria-expanded') === 'false') {
			toggle.click();
		}
	};
	const expandAtmosphere = (): void => {
		const header = document.querySelector<HTMLButtonElement>('[data-tour="atmosphere-header"]');
		if (header && header.getAttribute('aria-expanded') !== 'true') header.click();
	};
	const tourSteps: readonly TourStep[] = [
		{
			anchor: '[data-tour="rail"]',
			title: 'Layers live here',
			body: 'Toggle the data layers — VIIRS night-lights and the Falchi World Atlas for light pollution, plus live atmospheric overlays. Pick a basemap up top.',
			prepare: ensureRailOpen,
		},
		{
			anchor: '[data-tour="atmosphere"]',
			title: 'Atmosphere overlays',
			body: 'Clouds, aerosol (AOD) and water-vapor overlays. To analyze spectral transmission T(λ) for a spot, click the map and open it from the point readout.',
			prepare: () => {
				ensureRailOpen();
				expandAtmosphere();
			},
		},
		{
			anchor: '[data-tour="map"]',
			title: 'Click anywhere for a readout',
			body: 'Tap the map to pin a point: VIIRS brightness, World Atlas radiance, live atmospheric conditions, modeled PM2.5 — and a directable spectral-transmission T(λ) analysis for that exact spot.',
		},
		{
			anchor: '[data-tour="toolbar"]',
			title: 'Sun, moon & sharing',
			body: 'Open the twilight strip for sun/moon timing and the sky compass, follow your GPS, import a route, or copy a shareable link to this exact view.',
		},
	];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- mounted tile date bookkeeping, not reactive UI state
	const atmosphericTileDays = new Map<string, string>();
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
	let readoutGen = 0;
	let readoutInflight: AbortController | undefined;

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
	// V3 — the transmission path is a directable boresight. Elevation above the
	// horizon (90° = local zenith, the default) sets the slant-path zenith angle
	// and airmass; O₃ is a real input (was a hardcoded 350 DU). The azimuth dial +
	// sun/moon targeting + terrain occlusion arrive with the LookAngleControl (V3-4);
	// here the boresight stays at zenith but the geometry is no longer hardcoded.
	let transmissionElevationDeg = $state(90);
	let transmissionAzimuthDeg = $state(0);
	let transmissionLookTarget = $state<LookTarget>('zenith');
	let transmissionO3 = $state(350);
	// V3-4 — per-pin ephemeris (sun/moon alt-az + DEM horizon polygon) backing the
	// boresight: drives "aim at sun/moon" and terrain occlusion. Lifted to page
	// level (PointReadout computes its own, memoised — so this shares the cache).
	let transmissionPin = $state<PinEphemerisReadout | null>(null);
	let transmissionPinGen = 0;
	// True when the boresight is below the local terrain horizon — no line-of-sight
	// path, so the curve is suppressed (honest: a blocked path has no T(λ)).
	let transmissionBlocked = $state(false);
	let transmissionRecomputeTimer: ReturnType<typeof setTimeout> | undefined;

	// Boresight geometry derived from the current look-angle (display + occlusion).
	const lookZenithDeg = $derived(elevationToZenithDeg(transmissionElevationDeg));
	const lookAirmass = $derived(lookAngleAirmass(transmissionElevationDeg));
	const lookOcclusion = $derived.by(() => {
		const polygon = transmissionPin?.polygon;
		if (!polygon) return { occluded: false, horizonAltitudeDeg: null as number | null };
		return checkOcclusion({ azimuthDeg: transmissionAzimuthDeg, elevationDeg: transmissionElevationDeg }, polygon);
	});
	const sunAvailable = $derived((transmissionPin?.flat.sun.altitudeDeg ?? -1) > 0);
	const moonAvailable = $derived((transmissionPin?.flat.moon.altitudeDeg ?? -1) > 0);
	// V3-6 — the AOD fed to the curve resolves through a source cascade (measured
	// CAMS → modeled PM2.5 bridge → default slider) in buildTxConstituents; a
	// manual drag pins it. `transmissionAodManual` tracks that explicit override;
	// `transmissionConstituents` carries the per-field provenance for the sheet.
	let transmissionAodManual = $state(false);
	let transmissionConstituents = $state<TxConstituents | undefined>(undefined);
	// V3-7 — directable-area footprint: an azimuth sector + centerline drawn from
	// the selected point along the boresight. Visualization only (doesn't change
	// the curve). Azimuth comes from the boresight; beamwidth + range are local.
	let beamShow = $state(false);
	let beamBeamwidthDeg = $state(20);
	let beamRangeKm = $state(25);
	// Latest in-viewport OpenAQ stations, cached so a click can sample the
	// diffusion field without re-fetching. Mirrors the GeoJSON the heatmap uses.
	let pm25Stations = $state<Pm25Station[]>([]);
	// The clicked-point PM2.5 estimate, surfaced in the readout so the user
	// sees the modeled value + how much coverage it rests on. Null when smog
	// is off or no station is in range (never a fabricated value).
	let pm25Estimate = $state<Pm25Estimate | null>(null);
	// V3-5 — clicked-point pollen + air-quality reading (Open-Meteo CAMS). Null
	// while loading / on failure / before a point is selected; surfaced in the
	// readout. A failed fetch never sinks the rest of the readout.
	let airQualityReading = $state<AirQualityPointReading | null>(null);

	// Built once, not per keystroke — refreshTransmission runs on an 80ms debounce
	// off every slider/picker change, so rebuilding the merged layer literal each
	// call re-initializes both services needlessly.
	const TRANSMISSION_LAYER = Layer.merge(TransmissionEstimatorLive, MieScatteringServiceLive);

	async function refreshTransmission(): Promise<void> {
		// V3-4 — a terrain-occluded boresight has no line-of-sight path; show the
		// blocked state rather than a curve computed at a meaningless airmass.
		if (lookOcclusion.occluded) {
			transmissionBlocked = true;
			transmissionLoading = false;
			transmissionError = undefined;
			transmissionCurve = undefined;
			return;
		}
		transmissionBlocked = false;
		// V3-6 — resolve every constituent with honest provenance in one place.
		const constituents = buildTxConstituents({
			pwvMm: readout?.data?.atmospheric?.pwv ?? null,
			camsAod550: airQualityReading?.aod550 ?? null,
			pm25Estimate,
			manualAod550: transmissionAod,
			manualAodActive: transmissionAodManual,
			angstrom: transmissionAngstrom,
			o3Du: transmissionO3,
			// Column O₃ from the van Heuklon climatology for the selected point + date.
			o3ColumnDu: readout ? columnOzoneDu(readout.lat, readout.lon, ephemerisTime) : null,
			zenithDeg: elevationToZenithDeg(transmissionElevationDeg),
			zenithDirected: transmissionLookTarget !== 'zenith',
		});
		transmissionConstituents = constituents;
		// Reflect the resolved AOD back into the slider when not a manual override,
		// so the control shows the value actually used (CAMS / PM2.5 / default).
		if (!transmissionAodManual) transmissionAod = constituents.aod550.value;
		const input = toTransmissionInput(constituents);
		transmissionLoading = true;
		transmissionError = undefined;
		const aerosolType = transmissionAerosolType;
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* TransmissionEstimator;
				return aerosolType !== null
					? yield* svc.estimateWithLiveAerosol(input, aerosolType)
					: yield* svc.estimate(input);
			}).pipe(Effect.provide(TRANSMISSION_LAYER)),
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

	// V3 — the spectral-transmission sheet is point-anchored: it opens from the
	// PointReadout for the currently selected location and seeds its inputs from
	// that point. (The old independent LayerRail CTA / per-row (i) entry points
	// were removed; the tool is meaningless without a selected point.)
	function openTransmissionForPoint(): void {
		transmissionOpen = true;
		void loadTransmissionPin();
		void refreshTransmission();
	}

	// Load the per-pin ephemeris (sun/moon alt-az + DEM horizon) for the selected
	// point + time. Generation-guarded like the readout fetch so a stale point's
	// result can't clobber a newer one. Memoised in computePinEphemeris.
	async function loadTransmissionPin(): Promise<void> {
		if (!readout) {
			transmissionPin = null;
			return;
		}
		const gen = ++transmissionPinGen;
		const { lat, lon } = readout;
		try {
			const pin = await computePinEphemeris({ lat, lon }, ephemerisTime);
			if (gen === transmissionPinGen) {
				transmissionPin = pin;
				// A live sun/moon target re-snaps once geometry resolves.
				if (transmissionLookTarget === 'sun' || transmissionLookTarget === 'moon') reaimFromEphemeris();
			}
		} catch {
			if (gen === transmissionPinGen) transmissionPin = null;
		}
	}

	// Snap the boresight to the sun's or moon's current alt-az. Below-horizon
	// altitudes clamp to 0 so the occlusion/blocked path is surfaced honestly.
	function reaimFromEphemeris(): void {
		if (!transmissionPin) return;
		const body = transmissionLookTarget === 'moon' ? transmissionPin.flat.moon : transmissionPin.flat.sun;
		transmissionAzimuthDeg = normalizeAzimuthDeg(body.azimuthDeg);
		transmissionElevationDeg = Math.max(0, body.altitudeDeg);
	}

	function onLookTargetChange(t: LookTarget): void {
		transmissionLookTarget = t;
		if (t === 'zenith') {
			transmissionAzimuthDeg = 0;
			transmissionElevationDeg = 90;
		} else if (t === 'sun' || t === 'moon') {
			reaimFromEphemeris();
		}
		scheduleTransmissionRefresh();
	}
	function onLookAzimuthChange(v: number): void {
		transmissionAzimuthDeg = v;
		transmissionLookTarget = 'manual';
		scheduleTransmissionRefresh();
	}
	function onLookElevationChange(v: number): void {
		transmissionElevationDeg = v;
		transmissionLookTarget = 'manual';
		scheduleTransmissionRefresh();
	}

	function onAerosolTypeChange(value: AerosolType | null): void {
		transmissionAerosolType = value;
		scheduleTransmissionRefresh();
	}
	function onAodChange(value: number): void {
		transmissionAod = value;
		// Manual override pins the AOD over the CAMS / PM2.5 source cascade.
		transmissionAodManual = true;
		scheduleTransmissionRefresh();
	}

	const SMOG_LAYER_ID = 'smog-openaq-pm25';

	/**
	 * #275 — compute the local PM2.5 kernel-diffusion estimate at a clicked point.
	 * Surfaced in the readout AND consumed by buildTxConstituents as the modeled
	 * AOD fallback. Only when the smog overlay is on + stations are in range;
	 * never fabricates over sparse data (the estimator returns `none` → nothing).
	 */
	function refreshPm25Estimate(lat: number, lon: number): void {
		if (!layerState[SMOG_LAYER_ID]?.on || pm25Stations.length === 0) {
			pm25Estimate = null;
			return;
		}
		const est = estimatePm25At(pm25Stations, lon, lat);
		pm25Estimate = est.confidence === 'none' ? null : est;
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
		// Slant-path airmass for the current boresight (≈1.0 at zenith). null only
		// at/below the horizon, where there is no path — fall back to 1 defensively.
		const airmass = lookAngleAirmass(transmissionElevationDeg) ?? 1;
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* LineByLineService;
				return yield* svc.estimateInBand({ bandId, airmass });
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
		// Reset the boresight to the zenith default so the next open starts honestly
		// straight up rather than inheriting a stale look-angle.
		transmissionElevationDeg = 90;
		transmissionAzimuthDeg = 0;
		transmissionLookTarget = 'zenith';
		transmissionPin = null;
		transmissionBlocked = false;
		// Drop the manual AOD override so the next point re-resolves from its own
		// measured/modeled sources.
		transmissionAodManual = false;
		beamShow = false;
		removeBeamOverlay();
	}

	// V3-7 — directable-area footprint overlay (MapLibre GeoJSON), mirroring the
	// OpenAQ manual-source lifecycle (this controller is raster-only).
	const BEAM_SRC = 'darkmap-beam-src';
	const BEAM_FILL = 'darkmap-beam-fill-lyr';
	const BEAM_LINE = 'darkmap-beam-line-lyr';
	const BEAM_AMBER = '#ffd166';

	// Inline GeoJSON shape (no @types/geojson — see the route overlay above).
	type BeamFeature = {
		type: 'Feature';
		geometry: ReturnType<typeof beamSectorPolygon> | ReturnType<typeof beamCenterline>;
		properties: { kind: 'sector' | 'centerline' };
	};
	type BeamFC = { type: 'FeatureCollection'; features: BeamFeature[] };

	function beamFeatureCollection(): BeamFC | null {
		if (!readout) return null;
		const params = {
			origin: { lon: readout.lon, lat: readout.lat },
			azimuthDeg: transmissionAzimuthDeg,
			beamwidthDeg: beamBeamwidthDeg,
			rangeKm: beamRangeKm,
		};
		return {
			type: 'FeatureCollection',
			features: [
				{ type: 'Feature', geometry: beamSectorPolygon(params), properties: { kind: 'sector' } },
				{ type: 'Feature', geometry: beamCenterline(params), properties: { kind: 'centerline' } },
			],
		};
	}

	function removeBeamOverlay(): void {
		const map = mapInstance;
		if (!map) return;
		if (map.getLayer(BEAM_LINE)) map.removeLayer(BEAM_LINE);
		if (map.getLayer(BEAM_FILL)) map.removeLayer(BEAM_FILL);
		if (map.getSource(BEAM_SRC)) map.removeSource(BEAM_SRC);
	}

	function syncBeamOverlay(): void {
		const map = mapInstance;
		if (!map) return;
		const data = beamShow && transmissionOpen ? beamFeatureCollection() : null;
		if (!data) {
			removeBeamOverlay();
			return;
		}
		if (!map.isStyleLoaded()) {
			map.once('styledata', syncBeamOverlay);
			return;
		}
		const existing = map.getSource(BEAM_SRC) as import('maplibre-gl').GeoJSONSource | undefined;
		if (existing) {
			existing.setData(data);
			return;
		}
		map.addSource(BEAM_SRC, { type: 'geojson', data });
		map.addLayer({
			id: BEAM_FILL,
			type: 'fill',
			source: BEAM_SRC,
			filter: ['==', ['get', 'kind'], 'sector'],
			paint: { 'fill-color': BEAM_AMBER, 'fill-opacity': 0.12 },
		});
		map.addLayer({
			id: BEAM_LINE,
			type: 'line',
			source: BEAM_SRC,
			paint: { 'line-color': BEAM_AMBER, 'line-width': 1.5, 'line-opacity': 0.75 },
		});
	}

	function onBeamToggle(show: boolean): void {
		beamShow = show;
	}
	function onBeamwidthChange(v: number): void {
		beamBeamwidthDeg = v;
	}
	function onBeamRangeChange(v: number): void {
		beamRangeKm = v;
	}

	// Keep the footprint in sync with the boresight + beam params. Reading the
	// state inside syncBeamOverlay registers the dependencies; when the overlay is
	// hidden it only tracks beamShow/transmissionOpen and stays cheap.
	$effect(() => {
		syncBeamOverlay();
	});

	// V3-10 — AOD variation along the beam centerline, sampled from the cached
	// PM2.5 kernel-diffusion field (no extra fetches). Null when the beam is off,
	// no point is selected, or no stations are cached. Informational: the column
	// LUT doesn't path-integrate — this answers "does haze change down my beam?".
	const beamPathAod = $derived.by((): PathProfile | null => {
		if (!beamShow || !transmissionOpen || !readout || pm25Stations.length === 0) return null;
		const points = beamSamplePoints(
			{
				origin: { lon: readout.lon, lat: readout.lat },
				azimuthDeg: transmissionAzimuthDeg,
				beamwidthDeg: beamBeamwidthDeg,
				rangeKm: beamRangeKm,
			},
			8,
		);
		const samples = points.map((pt) => {
			const est = estimatePm25At(pm25Stations, pt.lon, pt.lat);
			return est.confidence === 'none' ? null : pm25ToAod550(est.valueUgm3);
		});
		return aggregatePath(samples);
	});

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
			// Watch failed to start — usually unsupported. Pull the typed failure
			// via Cause.failureOption so a Die/Sequential cause isn't silently
			// dropped (a bare `cause.error` cast only reads a top-level Fail node).
			const err = Option.getOrUndefined(Cause.failureOption(watchExit.cause)) as
				| { reason?: string; message?: string }
				| undefined;
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
			const err = Option.getOrUndefined(Cause.failureOption(exit.cause)) as
				| { reason?: string; message?: string }
				| undefined;
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

	function closeReadout(): void {
		readoutGen++;
		readoutInflight?.abort();
		readoutInflight = undefined;
		readout = undefined;
		pm25Estimate = null;
		airQualityReading = null;
		pointMarker?.remove();
		// V3 — the sheet is anchored to the selected point; clearing the point
		// leaves it with nothing to describe, so dismiss it too.
		if (transmissionOpen) closeTransmission();
	}

	async function queryAt(lat: number, lon: number): Promise<void> {
		const myGen = ++readoutGen;
		readoutInflight?.abort();
		const controller = new AbortController();
		readoutInflight = controller;
		const activeViirs = VIIRS_YEARS.find((l) => layerState[l.id]?.on)?.id ?? VIIRS_YEARS[0].id;
		readout = { lat, lon, loading: true };
		// Drop the locator crosshair immediately so the point is visible while the readout loads.
		pointMarker?.place(lon, lat);

		const featureinfoPromise = (async (): Promise<ReadoutData> => {
			const params = new URLSearchParams({ layer: activeViirs, lat: String(lat), lon: String(lon) });
			const res = await fetch(`/api/featureinfo?${params}`, { signal: controller.signal });
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			return (await res.json()) as ReadoutData;
		})();

		// Atmospheric reading rides through the AtmosphericPointService Effect
		// service so error reporting stays tagged. A failure here doesn't sink
		// the whole readout — we still want VIIRS / World Atlas values to land.
		const atmosphericPromise = Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* AtmosphericPointService;
				return yield* svc.getReading({ lat, lon, time: ephemerisTime }, { signal: controller.signal });
			}).pipe(Effect.provide(AtmosphericPointServiceLive)),
		);

		// V3-5 — pollen + air-quality (CAMS) rides its own isolated Effect so an
		// outage can't sink the readout; it just leaves the pollen section absent.
		const airQualityPromise = Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* AirQualityService;
				return yield* svc.getReading({ lat, lon, time: ephemerisTime }, { signal: controller.signal });
			}).pipe(Effect.provide(AirQualityServiceLive)),
		);

		try {
			const [featureinfo, atmosphericExit, airQualityExit] = await Promise.all([
				featureinfoPromise,
				atmosphericPromise,
				airQualityPromise,
			]);
			if (myGen !== readoutGen || controller.signal.aborted) return;
			const data: ReadoutData =
				atmosphericExit._tag === 'Success' ? { ...featureinfo, atmospheric: atmosphericExit.value } : featureinfo;
			readout = { lat, lon, loading: false, data };
			airQualityReading = airQualityExit._tag === 'Success' ? airQualityExit.value : null;
			// #275 — local PM2.5 estimate for the readout + the modeled AOD fallback.
			refreshPm25Estimate(lat, lon);
			// V3 — the curve is point-anchored: a new point's PWV / AOD (CAMS or the
			// PM2.5 bridge) must reseed the open sheet, and the per-pin ephemeris is
			// reloaded so the boresight's sun/moon snap + terrain occlusion track the
			// new location.
			if (transmissionOpen) {
				void loadTransmissionPin();
				scheduleTransmissionRefresh();
			}
		} catch (e) {
			if (myGen !== readoutGen || controller.signal.aborted) return;
			readout = { lat, lon, loading: false, error: e instanceof Error ? e.message : String(e) };
		} finally {
			if (readoutInflight === controller) {
				readoutInflight = undefined;
			}
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

	function rasterMountFor(l: RasterLayerDef, atmosphericDay = utcDayKey(ephemerisTime)) {
		const atmospheric = l.group === 'atmospheric';
		return {
			id: l.id,
			tileUrlTemplate: atmospheric ? atmosphericTileTemplate(l.id, { time: atmosphericDay }) : rasterUrlTemplate(l.id),
			opacity: layerState[l.id]?.opacity ?? l.opacity,
			...(l.maxNativeZoom !== undefined ? { maxZoom: l.maxNativeZoom } : {}),
			...(l.attribution ? { attribution: l.attribution } : {}),
		};
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
		const atmosphericDay = utcDayKey(ephemerisTime);
		if (atmospheric) {
			atmosphericTileDays.set(l.id, atmosphericDay);
			layerHealth.dispatch(l.id, { type: 'mount' });
		}
		void runController(Effect.flatMap(MapLayerController, (c) => c.mount(rasterMountFor(l, atmosphericDay))));
	}

	function unmountLayer(l: RasterLayerDef): void {
		if (l.pointSourceUrl) {
			unmountPointLayer(l);
			return;
		}
		// Clear the atmospheric health pill back to idle on toggle-off.
		if (l.group === 'atmospheric') {
			atmosphericTileDays.delete(l.id);
			layerHealth.dispatch(l.id, { type: 'unmount' });
		}
		void runController(Effect.flatMap(MapLayerController, (c) => c.unmount(l.id)));
	}

	function remountAtmosphericRasterLayersForDay(day: string): void {
		if (!controllerLayer) return;
		for (const l of LAYERS) {
			if (l.group !== 'atmospheric' || !l.upstreamUrlTemplate || !layerState[l.id]?.on) continue;
			if (atmosphericTileDays.get(l.id) === day) continue;
			atmosphericTileDays.set(l.id, day);
			layerHealth.dispatch(l.id, { type: 'mount' });
			void runController(
				Effect.flatMap(MapLayerController, (c) =>
					Effect.gen(function* () {
						yield* c.unmount(l.id);
						yield* c.mount(rasterMountFor(l, day));
					}),
				),
			);
		}
	}

	function setEphemerisTime(next: Date): void {
		const previousDay = utcDayKey(ephemerisTime);
		const nextDay = utcDayKey(next);
		ephemerisTime = next;
		if (previousDay !== nextDay) remountAtmosphericRasterLayersForDay(nextDay);
		// V3-4 — sun/moon boresight geometry is time-dependent; reload the pin
		// ephemeris (which re-snaps a live target) and recompute the open sheet.
		if (transmissionOpen) {
			void loadTransmissionPin();
			scheduleTransmissionRefresh();
		}
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
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight request bookkeeping, not reactive UI state
	const pointFetchInflight = new Map<string, AbortController>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- stale-response generation bookkeeping, not reactive UI state
	const pointFetchGen = new Map<string, number>();
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
		pointFetchGen.set(l.id, (pointFetchGen.get(l.id) ?? 0) + 1);
		pointFetchInflight.get(l.id)?.abort();
		pointFetchInflight.delete(l.id);
		// #275 — drop the cached stations + the PM2.5 estimate so the transmission
		// AOD cascade stops using it; recompute the open sheet.
		if (l.id === SMOG_LAYER_ID) {
			pm25Stations = [];
			pm25Estimate = null;
			if (transmissionOpen) scheduleTransmissionRefresh();
		}
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

		// Cancel any in-flight viewport fetch for this point layer so fast pans,
		// toggles, and unmounts cannot write stale station data.
		pointFetchInflight.get(l.id)?.abort();
		const controller = new AbortController();
		pointFetchInflight.set(l.id, controller);
		const myGen = (pointFetchGen.get(l.id) ?? 0) + 1;
		pointFetchGen.set(l.id, myGen);
		const stillCurrent = (): boolean =>
			!controller.signal.aborted && POINT_SOURCE_IDS.has(l.id) && pointFetchGen.get(l.id) === myGen;

		try {
			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const svc = yield* OpenAQService;
					return yield* svc.getSensors(bbox, { signal: controller.signal });
				}).pipe(Effect.provide(OpenAQServiceLive)),
			);
			if (!stillCurrent()) return;
			if (exit._tag !== 'Success') {
				// Soft-fail — keep whatever the previous data was; the proxy returns
				// degraded:true for missing keys so we won't normally enter here.
				layerHealth.dispatch(l.id, { type: 'tile-error', reason: 'fetch failed' });
				return;
			}
			const fc: OpenAQSensorCollection = exit.value;
			// #275 — cache stations so a clicked point can sample the diffusion field.
			if (l.id === SMOG_LAYER_ID) {
				pm25Stations = fc.features.map((f) => ({
					lon: f.geometry.coordinates[0],
					lat: f.geometry.coordinates[1],
					value: f.properties.value,
				}));
			}
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
		} finally {
			if (pointFetchInflight.get(l.id) === controller) {
				pointFetchInflight.delete(l.id);
			}
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
		// Locator marker — anchors each readout's numbers to a visible point.
		pointMarker = new PointMarkerController({ maplibre, map: mapInstance });

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

	// First-run guided tour — its own onMount so it never depends on the map
	// init succeeding (MapLibre throws without WebGL). Once per browser, after a
	// short settle; replayable any time from the toolbar "Take the guided tour".
	onMount(() => {
		if (!browser || localStorage.getItem(TOUR_FLAG)) return;
		localStorage.setItem(TOUR_FLAG, '1');
		const t = setTimeout(() => {
			tourOpen = true;
		}, 1200);
		return () => clearTimeout(t);
	});

	onDestroy(() => {
		clearTimeout(hashWriteTimer);
		readoutGen++;
		readoutInflight?.abort();
		for (const controller of pointFetchInflight.values()) {
			controller.abort();
		}
		pointFetchInflight.clear();
		stopFollow();
		clearRoute();
		pointMarker?.remove();
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
	data-tour="map"
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
/>
<Tour bind:open={tourOpen} steps={tourSteps} />
{#if transmissionOpen}
	<TransmissionSheet
		curve={transmissionCurve}
		loading={transmissionLoading}
		error={transmissionError}
		onclose={closeTransmission}
		aerosolType={transmissionAerosolType}
		aod={transmissionAod}
		aodSource={transmissionConstituents?.aod550.caption}
		pwvSource={transmissionConstituents?.pwv.caption}
		angstrom={transmissionAngstrom}
		{onAerosolTypeChange}
		{onAodChange}
		{onAngstromChange}
		selectedBandId={transmissionBandId}
		bandCurve={transmissionBandCurve}
		bandLoading={transmissionBandLoading}
		bandError={transmissionBandError}
		{onBandSelect}
		lookAzimuthDeg={transmissionAzimuthDeg}
		lookElevationDeg={transmissionElevationDeg}
		lookTarget={transmissionLookTarget}
		{lookZenithDeg}
		{lookAirmass}
		lookHorizonAltDeg={lookOcclusion.horizonAltitudeDeg}
		lookOccluded={lookOcclusion.occluded}
		blocked={transmissionBlocked}
		{sunAvailable}
		{moonAvailable}
		lookHorizon={transmissionPin?.polygon ?? null}
		{onLookTargetChange}
		{onLookAzimuthChange}
		{onLookElevationChange}
		showBeam={beamShow}
		beamwidthDeg={beamBeamwidthDeg}
		{beamRangeKm}
		{onBeamToggle}
		{onBeamwidthChange}
		{onBeamRangeChange}
		pathAod={beamPathAod}
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
			setEphemerisTime(t);
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
					setEphemerisTime(new Date());
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
		{
			id: 'tour',
			label: 'Take the guided tour',
			icon: Compass,
			title: 'Take the guided tour',
			pressed: tourOpen,
			onclick: () => (tourOpen = true),
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
		pm25={pm25Estimate}
		airQuality={airQualityReading}
		onclose={closeReadout}
		onTransmissionForPoint={openTransmissionForPoint}
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
		color: var(--accent-amber);
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
		background: var(--accent-amber);
		border: 2px solid rgba(8, 10, 16, 0.85);
		box-shadow: 0 0 0 6px rgba(var(--accent-amber-rgb), 0.18);
		cursor: pointer;
	}
	:global(.follow-marker[data-freshness='stale']) {
		background: rgba(var(--accent-amber-rgb), 0.55);
		box-shadow: 0 0 0 6px rgba(var(--accent-amber-rgb), 0.08);
	}
	:global(.follow-marker)::after {
		content: '';
		position: absolute;
		inset: -4px;
		border-radius: 50%;
		border: 1px solid rgba(var(--accent-amber-rgb), 0.55);
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
