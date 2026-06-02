<script lang="ts">
	import { Cause, Effect, Layer, Option } from 'effect';
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
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
	import {
		OpenAQService,
		OpenAQServiceLive,
		POLLUTANT_NAMES,
		type OpenAQSensorCollection,
	} from '$lib/effect/services/OpenAQService';
	import {
		OpenAQHistoryService,
		OpenAQHistoryServiceLive,
		type HistorySeries,
	} from '$lib/effect/services/OpenAQHistoryService';
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
	import { buildAqiField } from '$lib/atmospheric/aqi-field';
	import {
		DEFAULT_DIFFUSION,
		estimatePm25At,
		estimatePollutantAt,
		pm25ToAod550,
		type DiffusionParams,
		type Pm25Estimate,
		type Pm25Station,
		type WindVector,
	} from '$lib/atmospheric/pm25-diffusion';
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
	import LensSwitcher from '$lib/components/LensSwitcher.svelte';
	import PassPlanPanel from '$lib/components/PassPlanPanel.svelte';
	import MapErrorToast, { type ToastErr } from '$lib/components/MapErrorToast.svelte';
	import MapToolbar from '$lib/components/MapToolbar.svelte';
	import PointReadout, { type ReadoutData } from '$lib/components/PointReadout.svelte';
	import SkyCompass from '$lib/components/SkyCompass.svelte';
	import InstrumentColumn from '$lib/components/InstrumentColumn.svelte';
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
	import { lensStore } from '$lib/lens.svelte';
	import { LENSES, LENS_ANNOUNCE, type Lens } from '$lib/lens';

	// TEMP W1 BISECT: when true, the rail/inspector/dock CONTENT is omitted so the
	// fontless RBE cell renders only the grid skeleton + header + stage/map. Splits
	// "grid structure pegs the main thread" from "a content component pegs it" in a
	// single CI cycle. MUST be false before merge.
	const W1_BISECT_EMPTY = true;

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
	// An explicit basemap — a shared `&b=` link or a user chip click — always
	// wins over the per-lens nudge below (PR5). A `&b=` on load counts as explicit.
	let userChoseBasemap = $state(browser ? !!decodeHash(window.location.hash).basemap : false);
	// The Air lens nudges the Smog (PM2.5) station layer on (its signature data).
	// Any explicit layer choice — a manual toggle or a shared `&l=` link — pins
	// the user's layers and stops the nudge, exactly like `userChoseBasemap`.
	let userToggledSmog = $state(browser ? !!decodeHash(window.location.hash).layers : false);

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
	let passPlanOpen = $state(false);
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
	// AQ-1 — representative units per criteria pollutant, harvested from the
	// in-viewport stations (OpenAQ normalizes units per parameter), for readout labels.
	let pollutantUnits = $state<Record<string, string>>({});
	// The clicked-point PM2.5 estimate, surfaced in the readout so the user
	// sees the modeled value + how much coverage it rests on. Null when smog
	// is off or no station is in range (never a fabricated value).
	let pm25Estimate = $state<Pm25Estimate | null>(null);
	// AQ-1 — clicked-point per-criteria-pollutant diffused estimates (name → estimate),
	// for the multi-pollutant readout panel. Null when smog off / no coverage.
	let aqEstimates = $state<Record<string, Pm25Estimate> | null>(null);
	// V6-1 (TIN-1753) — the most recent point readout's 10 m wind, reused as a
	// SINGLE representative wind for the whole AQI density field so the rendered
	// field leans downwind the same way the point readout's kernel already does.
	// This is a deliberate, documented approximation: one uniform wind over the
	// entire viewport (real wind varies across a continental view). We reuse the
	// readout's wind rather than firing a second Open-Meteo fetch — no extra
	// network call, and it stays consistent with the value the user just saw.
	// Null until a point with usable wind has been read; the field stays
	// isotropic (its original behavior) until then.
	let fieldWind = $state<WindVector | null>(null);
	// V3-5 — clicked-point pollen + air-quality reading (Open-Meteo CAMS). Null
	// while loading / on failure / before a point is selected; surfaced in the
	// readout. A failed fetch never sinks the rest of the readout.
	let airQualityReading = $state<AirQualityPointReading | null>(null);
	// V6-2 — recent hourly PM2.5 history of the nearest OpenAQ station (sparkline +
	// rolling stats in the readout). Null while loading / on failure / no station;
	// its own isolated Effect so an outage can't sink the readout.
	let stationHistory = $state<HistorySeries | null>(null);
	let stationHistoryLoading = $state(false);

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
		passPlanOpen = false;
		transmissionOpen = true;
		void loadTransmissionPin();
		void refreshTransmission();
	}

	// Orbit deep tool: SGP4 passes gated by the local DEM horizon for this pin.
	function openPassPlanForPoint(): void {
		transmissionOpen = false;
		passPlanOpen = true;
	}
	function closePassPlan(): void {
		passPlanOpen = false;
	}

	// Hand off to the dedicated AQ-analysis dashboard (/aq, V6-4), seeded from the
	// selected point + ephemeris time via the shared URL-hash codec. The map zoom
	// rides along so a "View on map" return lands where we left.
	function openAqDashboardForPoint(): void {
		if (!readout) return;
		const hash = encodeHash({
			view: { lat: readout.lat, lon: readout.lon, zoom: mapInstance?.getZoom() ?? 8 },
			time: ephemerisTime,
		});
		void goto(`/aq${hash}`);
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
	function refreshPm25Estimate(lat: number, lon: number, wind?: WindVector): void {
		if (!layerState[SMOG_LAYER_ID]?.on || pm25Stations.length === 0) {
			pm25Estimate = null;
			aqEstimates = null;
			return;
		}
		// AQ-4 — when the clicked point's atmospheric reading carries a non-calm
		// wind, orient the diffusion kernel downwind; otherwise stay isotropic.
		const params: DiffusionParams = wind && wind.speedMps > 0 ? { ...DEFAULT_DIFFUSION, wind } : DEFAULT_DIFFUSION;
		const est = estimatePm25At(pm25Stations, lon, lat, params);
		pm25Estimate = est.confidence === 'none' ? null : est;
		// AQ-1 — diffuse every criteria pollutant the cached stations report.
		const byPollutant: Record<string, Pm25Estimate> = {};
		for (const p of POLLUTANT_NAMES) {
			const e = estimatePollutantAt(pm25Stations, lon, lat, p, params);
			if (e.confidence !== 'none') byPollutant[p] = e;
		}
		aqEstimates = Object.keys(byPollutant).length > 0 ? byPollutant : null;
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
		aqEstimates = null;
		airQualityReading = null;
		stationHistory = null;
		stationHistoryLoading = false;
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

		// V6-2 — nearest-station recent hourly PM2.5 history (sparkline + 24-h mean +
		// trend). Fully isolated: it resolves on its own timeline and updates state
		// directly, so a slow/failed history fetch never delays or sinks the readout.
		// It self-cancels when a newer point is clicked (generation + abort guards).
		stationHistory = null;
		stationHistoryLoading = true;
		void Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* OpenAQHistoryService;
				return yield* svc.getHistory({ lat, lon, param: 'pm25', hours: 24 }, { signal: controller.signal });
			}).pipe(Effect.provide(OpenAQHistoryServiceLive)),
		).then((exit) => {
			if (myGen !== readoutGen || controller.signal.aborted) return;
			stationHistory = exit._tag === 'Success' ? exit.value.series : null;
			stationHistoryLoading = false;
		});

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
			// AQ-4 — thread the clicked point's 10 m wind (when present) so the
			// kernel leans plumes downwind; falls back to isotropic when absent.
			const windReading =
				atmosphericExit._tag === 'Success' &&
				atmosphericExit.value.windSpeed !== null &&
				atmosphericExit.value.windDirectionDeg !== null
					? { speedMps: atmosphericExit.value.windSpeed, directionDeg: atmosphericExit.value.windDirectionDeg }
					: undefined;
			refreshPm25Estimate(lat, lon, windReading);
			// V6-1 — reuse this point's wind as the field's representative (uniform)
			// wind so the AQI density field leans downwind too. A rebuild repaints the
			// field with the freshly-known wind orientation.
			if (windReading && windReading.speedMps > 0) {
				fieldWind = windReading;
				renderAqiField();
			}
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
				lens: lensStore.lens, // encodeHash omits the `sky` default
			});
			history.replaceState(null, '', hash || window.location.pathname);
		}, 250);
	}

	// Number-key lens accelerator: 1→Sky, 2→Air, 3→Links, 4→Orbit. Guarded so it
	// never hijacks typing in the geocoder / any input. (The visible switcher
	// chips land in S1/PR2; this is the keyboard path.)
	function onLensKey(e: KeyboardEvent): void {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
			return;
		}
		const idx = Number.parseInt(e.key, 10) - 1;
		if (Number.isInteger(idx) && idx >= 0 && idx < LENSES.length) {
			lensStore.set(LENSES[idx]);
			scheduleHashWrite();
		}
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
			pollutantUnits = {};
			pm25Estimate = null;
			aqEstimates = null;
			removeAqiField();
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
			// #275 / AQ-1 — cache stations (with every criteria pollutant) so a
			// clicked point can diffuse each pollutant. `value` stays PM2.5.
			if (l.id === SMOG_LAYER_ID) {
				pm25Stations = fc.features.map((f) => ({
					lon: f.geometry.coordinates[0],
					lat: f.geometry.coordinates[1],
					value: f.properties.value,
					pollutants: Object.fromEntries(
						Object.entries(f.properties.pollutants ?? {}).map(([name, r]) => [name, r?.value ?? null]),
					),
				}));
				const units: Record<string, string> = {};
				for (const f of fc.features) {
					for (const [name, r] of Object.entries(f.properties.pollutants ?? {})) {
						if (r?.units && !units[name]) units[name] = r.units;
					}
				}
				pollutantUnits = units;
			}
			// AQ-1 — the smog overlay stays PM2.5-only: render just the stations that
			// report PM2.5 (others are cached for the readout but would otherwise show
			// as "no PM2.5" slate dots and dilute the layer). AQ-3 reworks this into an
			// AQI density field.
			const rendered: OpenAQSensorCollection = {
				...fc,
				features: fc.features.filter((f) => f.properties.value !== null),
			};
			const src = map.getSource(pointSourceId(l.id));
			if (src && 'setData' in src && typeof src.setData === 'function') {
				(src as { setData: (data: OpenAQSensorCollection) => void }).setData(rendered);
			}

			// AQ-3 — render the interpolated AQI density field (replaces the heatmap
			// blur; renderAqiField hides the heatmap layer when it paints).
			if (l.id === SMOG_LAYER_ID) renderAqiField();

			// Health-state dispatch (#196). degraded:true means OPENAQ_API_KEY is
			// unset upstream or returned 401/403 — surface as 'no data' so users
			// know the overlay is intentionally blank rather than broken.
			if (fc.degraded === true) {
				layerHealth.dispatch(l.id, { type: 'tile-empty', reason: 'OpenAQ proxy degraded' });
			} else if (rendered.features.length === 0) {
				layerHealth.dispatch(l.id, { type: 'tile-empty', reason: 'no PM2.5 sensors in viewport' });
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

	// AQ-3 — rendered AQI density field. A coarse viewport grid of composite-AQI
	// cells (from the same kernel diffusion as the readout) rasterized to a
	// MapLibre `image` source, replacing the heatmap-blur-over-points. Rebuilt
	// after each smog refresh (which runs on moveend); transparent where there's
	// no station coverage, so it only paints over real support.
	const AQI_FIELD_SRC = 'darkmap-aqi-field-src';
	const AQI_FIELD_LYR = 'darkmap-aqi-field-lyr';
	let aqiFieldCanvas: HTMLCanvasElement | undefined;

	function removeAqiField(): void {
		const map = mapInstance;
		if (!map) return;
		if (map.getLayer(AQI_FIELD_LYR)) map.removeLayer(AQI_FIELD_LYR);
		if (map.getSource(AQI_FIELD_SRC)) map.removeSource(AQI_FIELD_SRC);
	}

	function renderAqiField(): void {
		const map = mapInstance;
		if (!map || !layerState[SMOG_LAYER_ID]?.on || pm25Stations.length === 0) {
			removeAqiField();
			return;
		}
		if (!map.isStyleLoaded()) {
			map.once('styledata', renderAqiField);
			return;
		}
		const b = map.getBounds();
		const bbox = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
		const lonSpan = bbox.east - bbox.west;
		const latSpan = bbox.north - bbox.south;
		if (!(lonSpan > 0) || !(latSpan > 0)) {
			removeAqiField();
			return;
		}
		// Coarse grid (MapLibre linear-resamples the raster to a smooth field); the
		// height tracks the viewport aspect, capped so a moveend rebuild stays cheap.
		const gridW = 64;
		const gridH = Math.min(64, Math.max(1, Math.round(gridW * (latSpan / lonSpan))));
		// V6-1 (TIN-1753) — feed a single representative viewport wind (the most
		// recent point readout's 10 m wind) into the field so it leans downwind,
		// reusing the AQ-4 anisotropic kernel. This is a documented approximation:
		// one uniform wind stands in for the whole viewport, which over a large
		// (e.g. continental) view is only roughly right. Absent / calm wind keeps
		// the original isotropic field.
		const fieldParams: DiffusionParams | undefined =
			fieldWind && fieldWind.speedMps > 0 ? { ...DEFAULT_DIFFUSION, wind: fieldWind } : undefined;
		const field = buildAqiField(pm25Stations, bbox, gridW, gridH, {
			units: pollutantUnits,
			alpha: 150,
			params: fieldParams,
		});

		const heatId = pointHeatmapId(SMOG_LAYER_ID);
		if (field.painted === 0) {
			// No coverage in view — show nothing (honest); the station circles remain.
			removeAqiField();
			if (map.getLayer(heatId)) map.setLayoutProperty(heatId, 'visibility', 'none');
			return;
		}

		if (!aqiFieldCanvas) aqiFieldCanvas = document.createElement('canvas');
		aqiFieldCanvas.width = field.width;
		aqiFieldCanvas.height = field.height;
		const ctx = aqiFieldCanvas.getContext('2d');
		if (!ctx) return;
		const img = ctx.createImageData(field.width, field.height);
		img.data.set(field.rgba);
		ctx.putImageData(img, 0, 0);
		const url = aqiFieldCanvas.toDataURL();
		const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
			[bbox.west, bbox.north],
			[bbox.east, bbox.north],
			[bbox.east, bbox.south],
			[bbox.west, bbox.south],
		];

		const existing = map.getSource(AQI_FIELD_SRC) as import('maplibre-gl').ImageSource | undefined;
		if (existing) {
			existing.updateImage({ url, coordinates });
		} else {
			map.addSource(AQI_FIELD_SRC, { type: 'image', url, coordinates });
			// Below the station circles (dots stay on top), above the basemap.
			const circId = pointCircleId(SMOG_LAYER_ID);
			map.addLayer(
				{
					id: AQI_FIELD_LYR,
					type: 'raster',
					source: AQI_FIELD_SRC,
					paint: { 'raster-opacity': 0.85, 'raster-resampling': 'linear', 'raster-fade-duration': 0 },
				},
				map.getLayer(circId) ? circId : undefined,
			);
		}
		// The field replaces the heatmap blur.
		if (map.getLayer(heatId)) map.setLayoutProperty(heatId, 'visibility', 'none');
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

	// A user-initiated rail toggle of the Smog layer pins the choice so the Air
	// lens nudge stops managing it (mirrors onBasemapChange ⇒ userChoseBasemap).
	function onLayerChange(id: string, partial: Partial<LayerState>): void {
		if (id === SMOG_LAYER_ID && partial.on !== undefined) userToggledSmog = true;
		onChange(id, partial);
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
		// An explicit chip click pins the basemap — the lens nudge won't override it.
		userChoseBasemap = true;
		// Dispose health observability for the basemap we're leaving so the
		// LayerRail pill drops back to idle for the inactive entry.
		layerHealth.dispatch(activeBasemap, { type: 'unmount' });
		activeBasemap = id;
		if (mapInstance) applyBasemapLive(mapInstance, id);
		scheduleHashWrite();
	}

	// Per-lens basemap nudge (PR5): a SUBTLE default only — Sky/Links/Orbit read
	// best on Dark; Air leaves the basemap untouched (null). Never fires when the
	// user pinned a basemap (chip or `&b=`), and never animates the viewport.
	const lensBasemapDefault = (l: Lens): string | null => (l === 'air' ? null : DEFAULT_BASEMAP_ID);
	$effect(() => {
		const want = lensBasemapDefault(lensStore.lens);
		if (want === null || userChoseBasemap || want === activeBasemap) return;
		layerHealth.dispatch(activeBasemap, { type: 'unmount' });
		activeBasemap = want;
		if (mapInstance) applyBasemapLive(mapInstance, want);
		scheduleHashWrite();
	});

	// Apply the Air-lens Smog nudge to the live map WITHOUT persisting to the
	// shareable hash: the layer derives from the lens, so a shared `&lens=air`
	// reproduces the stations on the recipient's map without duplicating the
	// layer in `&l=`. (A user toggle, by contrast, persists via onChange.) If the
	// map hasn't mounted yet, layerState is set and the init loop mounts it.
	function setSmogNudge(on: boolean): void {
		const layer = LAYERS.find((l) => l.id === SMOG_LAYER_ID);
		if (!layer) return;
		const prev = layerState[SMOG_LAYER_ID] ?? { on: false, opacity: layer.opacity };
		if (prev.on === on) return;
		layerState[SMOG_LAYER_ID] = { ...prev, on };
		if (!mapInstance) return;
		if (on) mountLayer(layer);
		else unmountLayer(layer);
	}

	// Per-lens layer nudge: the Air lens's signature data IS the ground stations,
	// so Air turns the Smog (PM2.5) layer on and the other lenses turn the
	// system's own nudge back off — a SUBTLE default that never animates the
	// viewport. Never fires once the user has pinned the layer (manual toggle or
	// `&l=`); the user always wins. Surfaces a buried tool, never gates it.
	const lensWantsSmog = (l: Lens): boolean => l === 'air';
	$effect(() => {
		if (userToggledSmog) return;
		const want = lensWantsSmog(lensStore.lens);
		if ((layerState[SMOG_LAYER_ID]?.on ?? false) === want) return;
		setSmogNudge(want);
	});

	onMount(async () => {
		// Resolve the active lens before the map mounts: hash (shareable) wins,
		// else the remembered choice, else Sky. Map state stays orthogonal.
		lensStore.init(decodeHash(window.location.hash).lens);
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

<svelte:window onkeydown={onLensKey} />

<svelte:head>
	<title>darkmap</title>
	<meta
		name="description"
		content="Dark-sky planning map with VIIRS, Falchi 2016 World Atlas, terrain horizon, geocoder, and sun/moon timing."
	/>
	<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css" />
</svelte:head>

<!-- W1 — the Command Deck (docs/ux/command-deck.md §2). ONE CSS-grid app shell of
     named, non-overlapping regions replaces the .field-hud{pointer-events:none}
     float-soup + the z4→z13 ladder + the PR5 --portal-inset faux-grid. At WIDE
     (≥1024px) the regions are real grid tracks
     ('header header header' / 'rail stage inspector' / 'dock dock dock',
     [20rem][1fr][22rem]) so overlap is impossible by construction — the map can
     only be SHRUNK, never covered. ≤1023px the deck is `display:contents` (inert),
     so every child reverts to its current single-column float positioning — a
     TEMPORARY fallback until W4's full responsive reflow. -->
<div
	class="command-deck"
	data-ephemeris={ephemerisOpen ? 'open' : 'closed'}
	data-readout={readout ? 'open' : 'closed'}
	data-transmission={transmissionOpen ? 'open' : 'closed'}
	data-passplan={passPlanOpen ? 'open' : 'closed'}
>
	<!-- HEADER region: lens chips (left) + geocoder (right), out of the float-soup
	     into a reserved top row. ≤1023px display:contents → both keep their own
	     fixed placement. -->
	<header class="deck-header" aria-label="Lens + search">
		<LensSwitcher
			active={lensStore.lens}
			onselect={(lens) => {
				lensStore.set(lens);
				scheduleHashWrite();
			}}
		/>
		<!-- Announce the lens change to assistive tech (the visual re-weight is silent to SR). -->
		<p class="sr-only" aria-live="polite">{LENS_ANNOUNCE[lensStore.lens]}</p>

		<GeocoderSearch
			bias={viewCenter}
			onSelect={(sel) => {
				if (!mapInstance) return;
				mapInstance.flyTo({ center: [sel.lon, sel.lat], zoom: Math.max(11, mapInstance.getZoom()), essential: true });
			}}
		/>
	</header>

	<!-- RAIL region: the per-lens instrument row on top + the LayerRail below. At
	     WIDE this is the left grid track (20rem) — it PUSHES the stage, never
	     overlays it. ≤1023px display:contents → LayerRail keeps its mobile-drawer
	     positioning (the rail-toggle + backdrop live inside LayerRail, fixed). -->
	<aside class="left-dock" aria-label="Lens dock">
		<!-- TEMP W1 BISECT: rail content disabled to localize the fontless-cell layout peg. REVERT. -->
		{#if !W1_BISECT_EMPTY}
			<InstrumentColumn lens={lensStore.lens} stations={pm25Stations} location={viewCenter} time={ephemerisTime} />
			<div class="left-dock-scroll">
				<LayerRail
					lens={lensStore.lens}
					layers={LAYERS}
					states={layerState}
					onchange={onLayerChange}
					basemap={activeBasemap}
					onbasemapchange={onBasemapChange}
					time={ephemerisTime}
				/>
			</div>
		{/if}
	</aside>

	<!-- STAGE region: the MapLibre canvas as grid-area:stage — NO position:fixed,
	     NO inset. The grid sizes the map; regions shrink it, never cover it.
	     `.stage` is position:relative so the remaining float overlays (toolbar,
	     sky compass, deep-tool sheets, toasts, attribution) clip to the stage box
	     at WIDE — out of the header/rail/inspector/dock cells by construction.
	     MapLibre's trackResize (on by default) re-fires map.resize() on the grid
	     resize. ≤1023px display:contents → .map keeps inset:0 full-bleed. -->
	<div class="stage">
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

		<!-- Decorative frame — now the STAGE cell's border (was a z4 fixed overlay
		     reading the --portal-inset tokens). A pointer-events:none sibling so it
		     never intercepts map drags. Inert until the WIDE grid engages. -->
		<div class="portal-frame" aria-hidden="true"></div>

		{#if dragOver}
			<div class="drop-hint" aria-hidden="true">Drop a KML, GPX, or GeoJSON file to import</div>
		{/if}

		<MapErrorToast errors={toastErrors} onDismiss={dismissToast} />

		<!-- Float overlays not yet docked into a region (deep-tool sheets → W3,
		     toolbar/sky → W2). They stay position:fixed ≤1023px; at WIDE they are
		     absolutely positioned within the stage so they overlay only the map. -->
		{@render fieldFloats()}
	</div>

	<!-- INSPECTOR region: the persistent PointReadout as a docked right column at
	     WIDE (22rem track). ≤1023px display:contents → it keeps its bottom-right
	     float + click-to-open behaviour. -->
	<aside class="deck-inspector" aria-label="Point inspector">
		{#if !W1_BISECT_EMPTY}
			<PointReadout
				scope={readout ? 'point' : 'mean'}
				lens={lensStore.lens}
				lat={readout?.lat}
				lon={readout?.lon}
				time={ephemerisTime}
				data={readout?.data}
				loading={readout?.loading ?? false}
				error={readout?.error}
				pm25={pm25Estimate}
				{aqEstimates}
				{pollutantUnits}
				airQuality={airQualityReading}
				history={stationHistory}
				historyLoading={stationHistoryLoading}
				onclose={closeReadout}
				onTransmissionForPoint={openTransmissionForPoint}
				onAqDashboardForPoint={openAqDashboardForPoint}
				onPlanPassForPoint={openPassPlanForPoint}
			/>
		{/if}
	</aside>

	<!-- DOCK region: the twilight gantt as its OWN reserved bottom row at WIDE — so
	     "X floats over the twilight strip" is structurally impossible. ≤1023px
	     display:contents → the gantt keeps its current fixed bottom-strip layout. -->
	<div class="deck-dock">
		{#if ephemerisOpen && !W1_BISECT_EMPTY}
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
	</div>
</div>

<Tour bind:open={tourOpen} steps={tourSteps} />

{#snippet fieldFloats()}
	{#if transmissionOpen}
		<TransmissionSheet
			pointLat={readout?.lat}
			pointLon={readout?.lon}
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

	{#if passPlanOpen && readout}
		<PassPlanPanel location={{ lat: readout.lat, lon: readout.lon }} onclose={closePassPlan} />
	{/if}

	{#if ephemerisOpen}
		<SkyCompass location={viewCenter} time={ephemerisTime} />
	{/if}

	<MapToolbar
		items={[
			{
				id: 'ephemeris',
				label: ephemerisOpen ? 'Hide twilight strip' : 'Show twilight strip',
				shortLabel: 'Twilight',
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
				shortLabel: 'Follow',
				icon: LocateFixed,
				title: followButtonLabel(),
				pressed: followStatus !== 'off',
				onclick: toggleFollow,
			},
			{
				id: 'route',
				label: currentRoute ? `Clear imported route (${currentRoute.name})` : 'Import KML / GPX / GeoJSON route',
				shortLabel: currentRoute ? 'Clear' : 'Route',
				icon: currentRoute ? X : Upload,
				title: currentRoute ? `Clear ${currentRoute.name}` : 'Import KML / GPX / GeoJSON route',
				pressed: currentRoute !== null,
				onclick: triggerRoutePicker,
			},
			{
				id: 'tour',
				label: 'Take the guided tour',
				shortLabel: 'Tour',
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

	<footer class="attribution">
		<a href="/docs">credits + sources</a>
	</footer>
{/snippet}

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
	/* COMPACT/MEDIUM (≤1023px) base: the map is full-bleed fixed (display:contents
	   on the deck + stage means the map keeps this). The WIDE @media block below —
	   later in source order — promotes it to position:absolute inside the STAGE
	   cell, so the grid sizes it. */
	.map {
		position: fixed;
		inset: 0;
	}
	/* ===== W1 — the Command Deck grid shell (docs/ux/command-deck.md §2/§3) =====
	   ≤1023px: the deck is `display:contents` (inert) — every region wrapper is
	   also display:contents, so each child reverts to its own current fixed
	   positioning. This is the TEMPORARY single-column fallback (full responsive =
	   W4); it keeps the COMPACT layout byte-identical, which the 390px browser-RBE
	   smoke contracts depend on. */
	.command-deck,
	.deck-header,
	.stage,
	.deck-inspector,
	.deck-dock {
		display: contents;
	}
	/* WIDE (≥1024px): ONE real grid. Two areas can never occupy the same pixels,
	   so the map + twilight strip can only be SHRUNK, never occluded. Tracks:
	   [20rem rail][1fr stage][22rem inspector]; rows: header / body / dock. This
	   replaces the PR5 --portal-inset faux-grid + the z4→z13 ladder + the
	   .field-hud{pointer-events:none} scrim. */
	@media (min-width: 1024px) {
		.command-deck {
			display: grid;
			position: fixed;
			inset: 0;
			grid-template-columns: 20rem 1fr 22rem;
			/* minmax(0, …) on every row drops the implicit `min-content` floor.
			   That floor makes a track size to its content's intrinsic min, which —
			   with the fontless CI cell's zero-metric text — can enter a grid
			   track-sizing CYCLE that pegs the main thread before DCL (the page
			   never loads; no console). Capping the min at 0 breaks the cycle. */
			grid-template-rows: minmax(0, auto) minmax(0, 1fr) minmax(0, auto);
			grid-template-areas:
				'header header header'
				'rail stage inspector'
				'dock dock dock';
			gap: 0.75rem;
			padding: 0.75rem;
			box-sizing: border-box;
		}
		/* contain:layout isolates each region's internal layout so a child's
		   intrinsic sizing can't propagate back into the grid track computation
		   (belt-and-suspenders with minmax(0,…) against the fontless layout cycle). */
		.deck-header {
			grid-area: header;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 1rem;
			min-width: 0;
			min-height: 0;
			contain: layout;
		}
		.stage {
			grid-area: stage;
			display: block;
			position: relative;
			min-width: 0;
			min-height: 0;
			border-radius: 8px;
			overflow: hidden;
			contain: layout;
		}
		.deck-inspector {
			grid-area: inspector;
			display: block;
			min-width: 0;
			min-height: 0;
			overflow: hidden;
			contain: layout;
		}
		.deck-dock {
			grid-area: dock;
			display: block;
			min-width: 0;
			min-height: 0;
			overflow: hidden;
			contain: layout;
		}
		/* STAGE: the MapLibre canvas fills the stage cell — grid-area:stage, no
		   position:fixed, no inset. MapLibre trackResize (default-on) re-fires
		   map.resize() when the grid resizes this box. */
		.map {
			position: absolute;
			inset: 0;
		}

		/* De-fix the region children at WIDE: the lens chips + geocoder (HEADER),
		   the PointReadout (INSPECTOR), and the twilight gantt (DOCK) drop their
		   own position:fixed/inset/z-index and flow into their grid cells. Their
		   own ≤1023px float positioning is untouched (the COMPACT fallback). The
		   stage overlays (toolbar, sky, sheets) stay fixed — W2/W3 dock them. */
		.deck-header :global(.lens-switcher) {
			position: static;
			inset: auto;
			z-index: auto;
		}
		.deck-header :global(.geocoder) {
			position: relative;
			top: auto;
			left: auto;
			transform: none;
			z-index: auto;
			width: min(28rem, 100%);
		}
		/* The geocoder's results dropdown overlays following content (anchored to
		   the input), not the viewport. */
		.deck-header :global(.geocoder .dropdown) {
			position: absolute;
			left: 0;
			right: 0;
			z-index: 20;
		}
		/* INSPECTOR: the readout is the persistent right column — fills the 22rem
		   cell, no fixed anchor, scrolls within the cell. Covers the base readout
		   AND the deep-tool overview states (deep tools still float as sheets in
		   W1; W3 docks them into this column). */
		.deck-inspector :global(.readout) {
			position: static;
			inset: auto;
			z-index: auto;
			width: 100%;
			min-width: 0;
			max-width: none;
			max-height: 100%;
			overflow-y: auto;
			animation: none;
		}
		/* DOCK: the gantt is the full-width bottom row — drop its fixed bottom-strip
		   anchor + the toolbar inset (it owns the whole row now). */
		.deck-dock :global(.gantt) {
			position: static;
			inset: auto;
			left: auto;
			right: auto;
			bottom: auto;
			z-index: auto;
			width: 100%;
			box-sizing: border-box;
		}
		/* Stage overlays (toolbar bottom-right, sky compass top-right) become
		   position:absolute so they clip to the STAGE cell (which is
		   position:relative) instead of the viewport — keeping them off the
		   HEADER / INSPECTOR / DOCK regions by construction. The deep-tool sheets
		   (.sheet / .pass-plan) also clip to the stage; W3 docks them into the
		   inspector. MapErrorToast + drop-hint already live in the stage. */
		.stage :global(.toolbar) {
			position: absolute;
			right: 0.75rem;
			bottom: 0.75rem;
			z-index: 8;
		}
		.stage :global(.sky) {
			position: absolute;
			top: 0.75rem;
			right: 0.75rem;
			z-index: 6;
		}
		.stage :global(.sheet),
		.stage :global(.pass-plan) {
			position: absolute;
			left: 0;
			right: 0;
			bottom: 0;
			z-index: 12;
		}
		.stage :global(.maplibregl-ctrl-bottom-right) {
			z-index: 2;
		}
	}
	/* Decorative frame — at WIDE it is the STAGE cell's inset border (was a z4
	   fixed overlay reading the --portal-inset tokens). A pointer-events:none
	   sibling so it can never intercept map drags. Off (display:none) ≤1023px. */
	.portal-frame {
		display: none;
		position: absolute;
		inset: 0;
		pointer-events: none;
	}
	@media (min-width: 1024px) {
		.portal-frame {
			display: block;
		}
		/* Hairline inset edge — barely-there amber rule, no fill, map bleeds
		   through. Vignette is faint (≤0.5 alpha, no center darkening) per the
		   honesty bar — must not attenuate the VIIRS/World-Atlas raster. */
		.portal-frame::before {
			content: '';
			position: absolute;
			inset: 0;
			border: 1px solid rgba(var(--accent-amber-rgb), 0.16);
			box-shadow:
				inset 0 0 0 1px rgba(6, 8, 13, 0.5),
				inset 0 0 22px rgba(6, 8, 13, 0.3);
		}
		/* Four corner targeting brackets via 8 linear-gradient slices (GPU-cheap).
		   2px (even) arms stay crisp at fractional DPR; 22px long; faint glow. */
		.portal-frame::after {
			content: '';
			position: absolute;
			inset: 0;
			--b: 2px;
			--l: 22px;
			--c: rgba(var(--accent-amber-rgb), 0.85);
			background:
				linear-gradient(var(--c), var(--c)) top left / var(--l) var(--b) no-repeat,
				linear-gradient(var(--c), var(--c)) top left / var(--b) var(--l) no-repeat,
				linear-gradient(var(--c), var(--c)) top right / var(--l) var(--b) no-repeat,
				linear-gradient(var(--c), var(--c)) top right / var(--b) var(--l) no-repeat,
				linear-gradient(var(--c), var(--c)) bottom left / var(--l) var(--b) no-repeat,
				linear-gradient(var(--c), var(--c)) bottom left / var(--b) var(--l) no-repeat,
				linear-gradient(var(--c), var(--c)) bottom right / var(--l) var(--b) no-repeat,
				linear-gradient(var(--c), var(--c)) bottom right / var(--b) var(--l) no-repeat;
			filter: drop-shadow(0 0 3px rgba(var(--accent-amber-rgb), 0.4));
		}
	}
	/* a11y: kill all frame chrome under forced-colors / high-contrast. */
	@media (forced-colors: active) {
		.portal-frame::before,
		.portal-frame::after {
			content: none;
		}
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
	/* RAIL region. ≤1023px: display:contents = inert wrapper, so LayerRail +
	   InstrumentColumn fall back to their OWN positioning (the mobile drawer stays
	   unchanged). At WIDE: the left grid cell (20rem track) — a real region that
	   PUSHES the stage, never overlays it. Instrument row pinned on top
	   (flex:0 0 auto); the rail scrolls below (.left-dock-scroll owns the scroll;
	   the re-homed .layer-rail goes position:static + overflow:visible at WIDE).
	   The card chrome moves here from the rail. */
	.left-dock {
		display: contents;
	}
	@media (min-width: 1024px) {
		.left-dock {
			grid-area: rail;
			display: flex;
			flex-direction: column;
			gap: 0.6rem;
			min-width: 0;
			min-height: 0;
			background: rgba(8, 10, 16, 0.85);
			border: 1px solid rgba(255, 255, 255, 0.08);
			border-radius: 8px;
			padding: 0.85rem 0.9rem;
			box-sizing: border-box;
			overflow: hidden;
			contain: layout;
		}
		.left-dock :global(.instrument-column) {
			flex: 0 0 auto;
		}
		.left-dock-scroll {
			flex: 1 1 auto;
			min-height: 0;
			overflow-y: auto;
			scrollbar-width: none;
			-webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 1.25rem), transparent);
		}
		.left-dock-scroll::-webkit-scrollbar {
			display: none;
		}
	}
	/* The .field-hud{pointer-events:none} scrim is DELETED (W1, command-deck.md §2):
	   the grid regions own layout now; the remaining floats get native clicks
	   directly. The --field-* panel-geometry vars stay on .command-deck so the
	   COMPACT (≤1023px) float fallback below — the readout / sheet / toolbar /
	   attribution placement the 390px browser-RBE smoke depends on — keeps reading
	   them unchanged. The data-* state attributes moved from .field-hud onto
	   .command-deck. */
	.command-deck {
		--field-gap: 0.75rem;
		--field-panel-bottom: 0px;
		--field-panel-max-height: min(60vh, 28rem);
	}
	.command-deck[data-ephemeris='open'] {
		--field-panel-bottom: calc(
			var(--field-bottom-reserve, 8.75rem) + env(safe-area-inset-bottom, 0px) + var(--field-gap)
		);
		--field-panel-max-height: min(
			48vh,
			calc(100vh - var(--field-bottom-reserve, 8.75rem) - env(safe-area-inset-bottom, 0px) - 4.75rem)
		);
		--field-panel-max-height: min(
			48vh,
			calc(100dvh - var(--field-bottom-reserve, 8.75rem) - env(safe-area-inset-bottom, 0px) - 4.75rem)
		);
	}
	.command-deck[data-transmission='open'][data-readout='open'] {
		--field-panel-max-height: min(40vh, calc(100vh - var(--field-panel-bottom) - 15.25rem));
		--field-panel-max-height: min(40vh, calc(100dvh - var(--field-panel-bottom) - 15.25rem));
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
	/* WIDE: the attribution sits at the bottom-left of the STAGE cell (which is
	   position:relative), clear of the dock row. */
	@media (min-width: 1024px) {
		.attribution {
			bottom: 0.75rem;
			left: 0.75rem;
		}
	}
	/* Deep tool open → keep the point readout as the OVERVIEW (top-right, above the
	   bottom-docked detail sheet) instead of unmounting it (§11.5 overview+detail,
	   never occlude). The ≤820px rules below override with a compact placement;
	   this is the desktop default. Scoped to the COMPACT float fallback (≤1023px);
	   at WIDE the readout lives in the INSPECTOR grid cell so this never applies.
	   (Deep-tool-into-inspector docking is W3.) */
	@media (max-width: 1023px) {
		.command-deck[data-transmission='open'] :global(.readout[role='dialog']),
		.command-deck[data-passplan='open'] :global(.readout[role='dialog']) {
			top: calc(1rem + env(safe-area-inset-top, 0px));
			right: 1rem;
			bottom: auto;
			/* Reserve the bottom 34rem for the docked sheet (max 28rem + its offset +
			   a gap) so the overview never dips into the detail panel. */
			max-height: min(46vh, calc(100dvh - 34rem));
			overflow-y: auto;
		}
	}
	@media (max-width: 820px), (max-height: 500px) {
		.command-deck :global(.readout[role='dialog']) {
			bottom: calc(
				var(--field-bottom-reserve, 8.75rem) + env(safe-area-inset-bottom, 0px) + var(--field-gap)
			) !important;
			max-height: calc(
				100vh - var(--field-bottom-reserve, 8.75rem) - env(safe-area-inset-bottom, 0px) - 5rem
			) !important;
			max-height: calc(
				100dvh - var(--field-bottom-reserve, 8.75rem) - env(safe-area-inset-bottom, 0px) - 5rem
			) !important;
		}
		.command-deck[data-transmission='open'] :global(.readout[role='dialog']),
		.command-deck[data-passplan='open'] :global(.readout[role='dialog']) {
			top: calc(4.75rem + env(safe-area-inset-top, 0px)) !important;
			right: calc(var(--map-toolbar-inset-rem, 5rem) + 0.75rem) !important;
			bottom: auto !important;
			max-height: min(24dvh, 10rem) !important;
		}
		.command-deck[data-transmission='open'] :global(.toolbar),
		.command-deck[data-passplan='open'] :global(.toolbar) {
			top: max(0.75rem, env(safe-area-inset-top, 0px)) !important;
			bottom: auto !important;
		}
		.command-deck[data-transmission='open'] :global(.sheet) {
			right: calc(var(--map-toolbar-inset-rem, 5rem) + 0.75rem) !important;
			bottom: var(--field-panel-bottom) !important;
			max-height: var(--field-panel-max-height) !important;
			border-bottom: 1px solid rgba(255, 255, 255, 0.1);
			box-shadow: 0 -10px 28px rgba(0, 0, 0, 0.42);
		}
		.command-deck[data-readout='open'] .attribution,
		.command-deck[data-transmission='open'] .attribution,
		.command-deck[data-passplan='open'] .attribution {
			display: none;
		}
		.attribution {
			left: 0.75rem;
			bottom: calc(var(--field-bottom-reserve, 7.75rem) + env(safe-area-inset-bottom, 0px) + 6.25rem);
		}
	}
	/* TIN-1810: in portrait the gantt is taller than --field-bottom-reserve, so the
	   READOUT-ONLY state (transmission + passplan both closed) anchors its bottom at
	   --gantt-reserve-rem to clear the gantt instead of dipping ~60px into it. Scoped
	   to portrait + readout-only so the short/landscape concession and the
	   transmission/passplan top-strip placements are untouched. */
	@media (max-width: 820px) and (orientation: portrait) {
		.command-deck[data-readout='open']:not([data-transmission='open']):not([data-passplan='open'])
			:global(.readout[role='dialog']) {
			bottom: calc(var(--gantt-reserve-rem, 13rem) + env(safe-area-inset-bottom, 0px) + var(--field-gap)) !important;
			max-height: calc(100vh - var(--gantt-reserve-rem, 13rem) - env(safe-area-inset-bottom, 0px) - 5rem) !important;
			max-height: calc(100dvh - var(--gantt-reserve-rem, 13rem) - env(safe-area-inset-bottom, 0px) - 5rem) !important;
		}
	}
	@media (max-width: 820px) and (orientation: landscape), (max-height: 500px) {
		.command-deck[data-transmission='open'][data-readout='open'] {
			--field-panel-max-height: min(38vh, calc(100vh - var(--field-panel-bottom) - 1rem));
			--field-panel-max-height: min(38vh, calc(100dvh - var(--field-panel-bottom) - 1rem));
		}
		/* Cramped short/landscape: switcher (top-left) + the right-half sheet leave
		   no clean spot for the overview, so it yields until the tool closes — a
		   deliberate space concession (the readout returns on close), not gating. */
		.command-deck[data-transmission='open'] :global(.readout[role='dialog']),
		.command-deck[data-passplan='open'] :global(.readout[role='dialog']) {
			display: none;
		}
		.command-deck[data-transmission='open'] :global(.toolbar),
		.command-deck[data-passplan='open'] :global(.toolbar) {
			top: max(0.75rem, env(safe-area-inset-top, 0px)) !important;
		}
		.command-deck[data-transmission='open'] :global(.sheet) {
			right: calc(var(--map-toolbar-inset-rem, 5rem) + 0.75rem) !important;
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
