<script lang="ts">
	import { tick } from 'svelte';
	import { X } from '@lucide/svelte';
	import HelpTooltip from '$lib/components/HelpTooltip.svelte';
	import { DEFAULT_LENS, type Lens } from '$lib/lens';
	import { bortleFromArtificialMcd } from '$lib/skyBrightness';
	import type { PinEphemerisReadout } from '$lib/ephemeris/pinEphemeris';
	import {
		formatNearestKm,
		formatStationCount,
		pm25AqiCategory,
		pm25ToAod550,
		type Pm25Estimate,
	} from '$lib/atmospheric/pm25-diffusion';
	import { crossValidate } from '$lib/atmospheric/aq-crossval';
	import {
		POLLEN_SPECIES,
		type AirQualityPointReading,
		type PollenReading,
	} from '$lib/effect/services/AirQualityService';
	import { pollenOpticalDepth } from '$lib/atmospheric/pollen-extinction';
	import { computeAqi, type AqiPollutant, type AqiReading } from '$lib/atmospheric/aqi';
	import type { HistorySeries } from '$lib/effect/services/OpenAQHistoryService';

	export interface ReadoutData {
		readonly viirs?: {
			readonly layer: string;
			readonly red: number;
			readonly green: number;
			readonly blue: number;
			readonly alpha: number;
		};
		readonly worldAtlas?: {
			readonly grayIndex: number;
		};
		readonly atmospheric?: {
			/** Precipitable water column, mm. Null when unavailable from the point source. */
			readonly pwv: number | null;
			/** Relative humidity at 2 m, percent. */
			readonly rh: number;
			/** Low / mid / high cloud cover, percent. */
			readonly cloudLow: number;
			readonly cloudMid: number;
			readonly cloudHigh: number;
			/** Visibility, meters. */
			readonly visibility: number;
			/** ISO-8601 timestamp Open-Meteo matched to the requested time. */
			readonly matchedTime: string;
		};
	}

	interface Props {
		lat: number;
		lon: number;
		time: Date;
		data: ReadoutData | undefined;
		loading: boolean;
		error?: string;
		/** Clicked-point PM2.5 kernel-diffusion estimate (#275); null when smog off / no station in range. */
		pm25?: Pm25Estimate | null;
		/** AQ-1 — per-criteria-pollutant kernel-diffused estimates (name → estimate); null when none. */
		aqEstimates?: Record<string, Pm25Estimate> | null;
		/** AQ-1 — representative units per pollutant name, for labels. */
		pollutantUnits?: Record<string, string>;
		/** Clicked-point pollen + air-quality reading (Open-Meteo CAMS, V3-5); null when unavailable. */
		airQuality?: AirQualityPointReading | null;
		/** V6-2 — recent hourly history of the nearest OpenAQ station; null when none / loading-failed. */
		history?: HistorySeries | null;
		/** V6-2 — true while the history fetch is in flight (shows a quiet placeholder). */
		historyLoading?: boolean;
		onclose: () => void;
		/** Active persona lens (S1 PR4) — re-weights which sections lead/dim + the primary CTA. */
		lens?: Lens;
		/**
		 * Open the spectral-transmission sheet seeded from THIS point + time.
		 * The transmission tool is point-anchored (V3): the boresight geometry,
		 * PWV, and AOD all derive from the selected location, so the entry point
		 * lives here rather than as an independent rail CTA.
		 */
		onTransmissionForPoint?: () => void;
		/**
		 * Open the dedicated AQ-analysis dashboard (`/aq`) seeded from THIS point
		 * + time. The dashboard pulls the full time-series + multi-pollutant +
		 * source cross-validation for the location (V6-4).
		 */
		onAqDashboardForPoint?: () => void;
		/** Open the Orbit "Plan a pass" deep tool seeded from THIS point (S3). */
		onPlanPassForPoint?: () => void;
	}

	let {
		lat,
		lon,
		time,
		data,
		loading,
		error,
		pm25 = null,
		aqEstimates = null,
		pollutantUnits = {},
		airQuality = null,
		history = null,
		historyLoading = false,
		onclose,
		lens = DEFAULT_LENS,
		onTransmissionForPoint,
		onAqDashboardForPoint,
		onPlanPassForPoint,
	}: Props = $props();

	const POLLEN_LABELS: Record<keyof PollenReading, string> = {
		alder: 'Alder',
		birch: 'Birch',
		grass: 'Grass',
		mugwort: 'Mugwort',
		olive: 'Olive',
		ragweed: 'Ragweed',
	};
	// Species CAMS actually modeled here (value present, incl. a real 0). Null
	// species are out of season / unsupported — surfaced as "none reported", never 0.
	const reportedPollen = $derived(
		airQuality ? POLLEN_SPECIES.filter((s) => airQuality.pollen[s] !== null) : ([] as (keyof PollenReading)[]),
	);
	const missingPollenCount = $derived(POLLEN_SPECIES.length - reportedPollen.length);
	// V3-9 — geometric-optics optical depth from the pollen load. Informational:
	// it is ~1e-4–1e-3 even at heavy counts, i.e. negligible for transmission.
	const pollenTau = $derived(airQuality ? pollenOpticalDepth(airQuality.pollen) : null);

	// AQ-1 — criteria-pollutant display order + labels for the diffused panel.
	const POLLUTANT_LABELS: Record<string, string> = {
		pm25: 'PM2.5',
		pm10: 'PM10',
		no2: 'NO₂',
		o3: 'O₃',
		so2: 'SO₂',
		co: 'CO',
	};
	const POLLUTANT_ORDER = ['pm25', 'pm10', 'no2', 'o3', 'so2', 'co'];
	const aqRows = $derived(
		aqEstimates
			? POLLUTANT_ORDER.filter((p) => aqEstimates[p]?.valueUgm3 != null).map((p) => ({
					name: p,
					label: POLLUTANT_LABELS[p] ?? p,
					est: aqEstimates[p],
					units: pollutantUnits[p] ?? 'µg/m³',
				}))
			: [],
	);
	// AQ-2 — composite US-EPA AQI from the per-pollutant diffused values. Nowcast
	// approximation (latest values, not the official averaging windows); pollutants
	// whose units can't be resolved are skipped rather than guessed.
	const aqi = $derived.by(() => {
		if (aqRows.length === 0) return null;
		const readings: AqiReading[] = aqRows.map((r) => ({
			pollutant: r.name as AqiPollutant,
			value: r.est.valueUgm3 as number,
			units: r.units,
		}));
		return computeAqi(readings);
	});

	// V6-3 — cross-validate the air-quality sources at this point. Pure: lines up
	// OpenAQ diffused PM2.5 (measured) + its AOD550 bridge against CAMS PM2.5/AOD
	// (modeled), comparing ONLY where both carry a value. A missing source is no
	// data, never agreement. GIBS MODIS AOD is visual-only in v1 (no trustworthy
	// point-decode) — read it off the map, it is not part of the numeric compare.
	const crossVal = $derived.by(() => {
		const openaqPm25 = pm25?.valueUgm3 ?? null;
		return crossValidate({
			openaqPm25,
			openaqAod550FromPm25: pm25ToAod550(openaqPm25),
			camsPm25: airQuality?.pm25 ?? null,
			camsAod550: airQuality?.aod550 ?? null,
		});
	});
	// Only worth surfacing the section once at least one source is in play.
	const crossValHasSignal = $derived(crossVal.pairs.length > 0 || (pm25?.valueUgm3 != null && airQuality != null));

	// V6-2 — compact sparkline geometry for the nearest station's hourly history.
	// Real samples only: each point is plotted at its true position in the window
	// (x by timestamp, not by index), so a gap shows as a visibly longer segment
	// rather than a fabricated even spacing. We never draw a point for a missing
	// hour. A single sample renders as a dot; <1 renders nothing.
	const SPARK_W = 132;
	const SPARK_H = 26;
	const SPARK_PAD = 2;
	const sparkPoints = $derived.by(() => {
		const pts = history?.points ?? [];
		if (pts.length === 0) return [] as { x: number; y: number }[];
		const xs = pts.map((p) => Date.parse(p.at));
		const ys = pts.map((p) => p.value);
		const xMin = Math.min(...xs);
		const xMax = Math.max(...xs);
		const yMin = Math.min(...ys);
		const yMax = Math.max(...ys);
		const xSpan = xMax - xMin || 1;
		const ySpan = yMax - yMin || 1;
		const w = SPARK_W - SPARK_PAD * 2;
		const h = SPARK_H - SPARK_PAD * 2;
		return pts.map((p, i) => ({
			x: SPARK_PAD + ((xs[i] - xMin) / xSpan) * w,
			// invert y so larger values sit higher
			y: SPARK_PAD + (1 - (ys[i] - yMin) / ySpan) * h,
		}));
	});
	const sparkPath = $derived(
		sparkPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
	);
	const TREND_GLYPH: Record<NonNullable<HistorySeries['trend']>, string> = {
		rising: '↑',
		falling: '↓',
		flat: '→',
	};
	const fmtWindowHours = (s: HistorySeries): number =>
		Math.max(1, Math.round((Date.parse(s.windowTo) - Date.parse(s.windowFrom)) / 3_600_000));
	const HISTORY_LABELS: Record<string, string> = {
		pm25: 'PM2.5',
		pm10: 'PM10',
		no2: 'NO₂',
		o3: 'O₃',
		so2: 'SO₂',
		co: 'CO',
	};

	// Coverage phrasing is shared with the transmission widget (pm25-diffusion);
	// the readout joins the fragments with middot separators.
	const fmtNearest = (km: number | null): string => {
		const near = formatNearestKm(km);
		return near ? ` · ${near}` : '';
	};

	const fmtCoord = (n: number) => n.toFixed(4);
	const viirsAvg = $derived.by(() =>
		data?.viirs ? Math.round((data.viirs.red + data.viirs.green + data.viirs.blue) / 3) : undefined,
	);
	// Sky-lens lead: Bortle class + SQM from the Falchi artificial brightness
	// (modeled; provenance disclosed in the headline's HelpTooltip).
	const bortle = $derived.by(() => {
		const g = data?.worldAtlas?.grayIndex;
		return g === undefined ? undefined : bortleFromArtificialMcd(g);
	});

	// Lens re-weighting (S1 PR4): which sections lead (float up + Tier-1), which
	// dim (Tier-3, still present + clickable — never gated). Everything else is
	// Tier-2. Section ids match the `data-section` attrs in the template.
	type SectionId =
		| 'bortle'
		| 'viirs'
		| 'worldAtlas'
		| 'atmosphere'
		| 'aqi'
		| 'pm25'
		| 'pollutants'
		| 'history'
		| 'pollen'
		| 'crossval'
		| 'ephemeris';
	const LENS_LEAD: Record<Lens, readonly SectionId[]> = {
		sky: ['bortle', 'ephemeris'],
		air: ['aqi', 'pm25'],
		links: ['atmosphere'],
		orbit: ['ephemeris'],
	};
	const LENS_DIM: Record<Lens, readonly SectionId[]> = {
		// Off-lens night-lights + AQ families dim as whole units (kept clickable).
		sky: ['aqi', 'pm25', 'pollutants', 'pollen', 'history', 'crossval'],
		air: ['bortle', 'viirs', 'worldAtlas', 'ephemeris'],
		links: ['aqi', 'pm25', 'pollutants', 'pollen', 'history', 'crossval', 'bortle', 'viirs', 'worldAtlas'],
		orbit: ['aqi', 'pm25', 'pollutants', 'pollen', 'history', 'crossval', 'viirs', 'worldAtlas'],
	};
	const tierOf = (id: SectionId): 1 | 2 | 3 => (LENS_LEAD[lens].includes(id) ? 1 : LENS_DIM[lens].includes(id) ? 3 : 2);
	// Lead sections float to the top (negative order); dimmed sink below normal.
	const orderOf = (id: SectionId): number => (LENS_LEAD[lens].includes(id) ? -1 : LENS_DIM[lens].includes(id) ? 1 : 0);

	// CTA emphasis per lens (Air → AQ dashboard, Links → transmission). Sky/Orbit
	// lead with an in-readout section, so both CTAs read as secondary (Tier-3
	// ghost). The promoted CTA is rendered FIRST in the DOM (see template) so the
	// Tab order matches the visual order — no style:order desync (WCAG 2.4.3).
	const primaryCta = $derived(
		lens === 'air' ? 'aq' : lens === 'links' ? 'transmission' : lens === 'orbit' ? 'pass' : null,
	);
	const ctaTier = (id: 'transmission' | 'aq' | 'pass'): 1 | 3 => (primaryCta === id ? 1 : 3);

	// Lighthouse / horizon-aware ephemeris. Opens on click, fetches the
	// 36-ray terrain polygon + refined twilight events for this pin. The
	// helper memoises per (lat3, lon3, UTC-day) so re-opening the same
	// pin is instant.
	let ephemerisOpen = $state(false);
	let ephemeris: PinEphemerisReadout | null = $state(null);
	let ephemerisLoading = $state(false);
	let ephemerisError: string | null = $state(null);
	let readoutPanel: HTMLDivElement | undefined = $state();
	let lastScrollResetKey = '';

	async function loadEphemeris(): Promise<void> {
		ephemerisLoading = true;
		ephemerisError = null;
		try {
			const { computePinEphemeris } = await import('$lib/ephemeris/pinEphemeris');
			ephemeris = await computePinEphemeris({ lat, lon }, time);
		} catch (e) {
			ephemerisError = e instanceof Error ? e.message : String(e);
		} finally {
			ephemerisLoading = false;
		}
	}

	function toggleEphemeris(): void {
		ephemerisOpen = !ephemerisOpen;
		if (ephemerisOpen && !ephemeris && !ephemerisLoading) {
			void loadEphemeris();
		}
	}

	// Clicking a new pin wipes any prior ephemeris result so the section
	// shows the correct loading state when the user re-opens it.
	$effect(() => {
		// Track lat/lon/day, intentionally reset ephemeris when any change.
		const _ = `${lat}|${lon}|${time.getUTCFullYear()}-${time.getUTCMonth()}-${time.getUTCDate()}`;
		void _;
		ephemeris = null;
		ephemerisError = null;
	});

	$effect(() => {
		const resetKey = [
			lat.toFixed(5),
			lon.toFixed(5),
			time.getUTCFullYear(),
			time.getUTCMonth(),
			time.getUTCDate(),
			loading ? 'loading' : 'ready',
			data ? 'data' : 'empty',
			error ?? '',
		].join('|');
		if (readoutPanel && resetKey !== lastScrollResetKey) {
			lastScrollResetKey = resetKey;
			readoutPanel.scrollTop = 0;
			void tick().then(() => {
				if (readoutPanel && resetKey === lastScrollResetKey) {
					readoutPanel.scrollTop = 0;
				}
			});
		}
	});

	const fmtClock = (d: Date | null): string => {
		if (!d) return '—';
		const hh = d.getUTCHours().toString().padStart(2, '0');
		const mm = d.getUTCMinutes().toString().padStart(2, '0');
		return `${hh}:${mm}`;
	};

	const deltaMin = (flat: Date | null, refined: Date | null): string => {
		if (!flat || !refined) return '';
		const dMin = Math.round((refined.getTime() - flat.getTime()) / 60000);
		if (Math.abs(dMin) < 1) return '';
		return dMin > 0 ? ` (+${dMin}m)` : ` (${dMin}m)`;
	};
</script>

<div bind:this={readoutPanel} class="readout" data-lens={lens} role="dialog" aria-label="Point readout">
	<button class="close" type="button" aria-label="Close readout" onclick={onclose}>
		<X size={16} aria-hidden="true" />
	</button>
	<header>
		<h3>Point readout</h3>
		<p class="locator" title="Marked on the map">
			<svg
				class="locator-mark"
				viewBox="0 0 24 24"
				width="11"
				height="11"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="6" />
				<line x1="12" y1="0" x2="12" y2="4" />
				<line x1="12" y1="20" x2="12" y2="24" />
				<line x1="0" y1="12" x2="4" y2="12" />
				<line x1="20" y1="12" x2="24" y2="12" />
			</svg>
			<span>{fmtCoord(lat)}°, {fmtCoord(lon)}°</span>
		</p>
	</header>
	{#if lens === 'sky' && bortle}
		<section class="bortle-lead" data-section="bortle" data-tier={tierOf('bortle')} style:order={orderOf('bortle')}>
			<p class="bortle-class">
				Bortle {bortle.cls}
				<span class="bortle-label">{bortle.label}</span>
			</p>
			<p class="bortle-sqm">
				SQM ≈ {bortle.sqm.toFixed(2)}<span class="unit"> mag/arcsec²</span>
				<HelpTooltip
					text={`Modeled, not measured: Falchi 2016 artificial zenith brightness (${data?.worldAtlas?.grayIndex.toFixed(2)} mcd/m²) plus the natural dark-sky floor, mapped to SQM and the approximate Bortle scale. Cross-check it against the VIIRS measured pixel below.`}
				>
					{#snippet trigger()}
						<span class="modeled-tag">modeled</span>
					{/snippet}
				</HelpTooltip>
			</p>
		</section>
	{/if}
	{#if loading}
		<p class="loading">Querying upstream…</p>
	{:else if error}
		<p class="error">Error: {error}</p>
	{:else if data}
		{#if data.viirs}
			<section data-section="viirs" data-tier={tierOf('viirs')} style:order={orderOf('viirs')}>
				<h4>VIIRS pixel</h4>
				<p class="value">{viirsAvg}<span class="unit">/255</span></p>
				<p class="note">{data.viirs.layer} · RGB({data.viirs.red},{data.viirs.green},{data.viirs.blue})</p>
			</section>
		{/if}
		{#if data.worldAtlas}
			<section data-section="worldAtlas" data-tier={tierOf('worldAtlas')} style:order={orderOf('worldAtlas')}>
				<h4>World Atlas radiance</h4>
				<p class="value">{data.worldAtlas.grayIndex.toFixed(2)}<span class="unit"> mcd/m²</span></p>
				<p class="note">Falchi 2016 modeled artificial brightness</p>
			</section>
		{/if}
		{#if data.atmospheric}
			<section data-section="atmosphere" data-tier={tierOf('atmosphere')} style:order={orderOf('atmosphere')}>
				<h4>Atmosphere (Open-Meteo)</h4>
				<dl class="atmos-grid">
					<dt>PWV</dt>
					<dd>
						{#if data.atmospheric.pwv === null}
							<span class="muted">unavailable</span>
						{:else}
							{data.atmospheric.pwv.toFixed(1)}<span class="unit"> mm</span>
						{/if}
					</dd>
					<dt>RH</dt>
					<dd>{Math.round(data.atmospheric.rh)}<span class="unit"> %</span></dd>
					<dt>Cloud (L/M/H)</dt>
					<dd>
						{Math.round(data.atmospheric.cloudLow)}/{Math.round(data.atmospheric.cloudMid)}/{Math.round(
							data.atmospheric.cloudHigh,
						)}<span class="unit"> %</span>
					</dd>
					<dt>Visibility</dt>
					<dd>{(data.atmospheric.visibility / 1000).toFixed(1)}<span class="unit"> km</span></dd>
				</dl>
				<p class="note">Forecast hour {data.atmospheric.matchedTime}Z · CC-BY Open-Meteo</p>
			</section>
		{/if}
		{#if !data.viirs && !data.worldAtlas && !data.atmospheric}
			<p class="loading">No data at this point.</p>
		{/if}
	{/if}

	{#if aqi}
		<section class="aqi" data-section="aqi" data-tier={tierOf('aqi')} style:order={orderOf('aqi')}>
			<div class="aqi-badge" style="--aqi-color: {aqi.category.color}">
				<span class="aqi-value">{aqi.aqi}</span>
				<span class="aqi-meta">
					<span class="aqi-cat">AQI · {aqi.category.name}</span>
					<span class="aqi-dom">dominant {POLLUTANT_LABELS[aqi.dominant] ?? aqi.dominant}</span>
				</span>
				<HelpTooltip
					text="US-EPA Air Quality Index, composited as the max sub-index across the modeled criteria pollutants. Nowcast approximation: built from the latest kernel-diffused values, NOT the official averaging windows (PM 24-hr, O₃/CO 8-hr, SO₂/NO₂ 1-hr). Pollutants whose units can't be resolved are skipped."
				>
					{#snippet trigger()}
						<span class="modeled-tag">≈ nowcast</span>
					{/snippet}
				</HelpTooltip>
			</div>
		</section>
	{/if}

	{#if pm25 && pm25.valueUgm3 !== null}
		<section data-section="pm25" data-tier={tierOf('pm25')} style:order={orderOf('pm25')}>
			<h4>
				PM2.5
				<HelpTooltip
					text="Modeled, not measured: a Gaussian kernel-diffusion estimate from nearby OpenAQ ground stations (weighted by distance, with a Kish effective-N confidence). It is the surface concentration interpolated to this point — the confidence and station coverage are shown below."
				>
					{#snippet trigger()}
						<span class="modeled-tag">modeled</span>
					{/snippet}
				</HelpTooltip>
			</h4>
			<p class="value">{pm25.valueUgm3.toFixed(1)}<span class="unit"> µg/m³</span></p>
			<p class="note">{pm25AqiCategory(pm25.valueUgm3)}</p>
			<p class="note coverage" class:low={pm25.confidence === 'low'}>
				{pm25.confidence} confidence · {formatStationCount(pm25.contributingStations)}{fmtNearest(pm25.nearestKm)}
			</p>
		</section>
	{/if}

	{#if aqRows.some((r) => r.name !== 'pm25')}
		<section data-section="pollutants" data-tier={tierOf('pollutants')} style:order={orderOf('pollutants')}>
			<h4>
				Other pollutants
				<HelpTooltip
					text="Modeled, not measured: each criteria pollutant kernel-diffused from nearby OpenAQ ground stations (same Gaussian estimate as PM2.5). Coverage and confidence are per-pollutant — a station may report PM2.5 but not O₃. Units are the OpenAQ provider units."
				>
					{#snippet trigger()}
						<span class="modeled-tag">modeled</span>
					{/snippet}
				</HelpTooltip>
			</h4>
			<dl>
				{#each aqRows as row (row.name)}
					{#if row.name !== 'pm25'}
						<dt>{row.label}</dt>
						<dd>
							{row.est.valueUgm3!.toFixed(row.est.valueUgm3! < 10 ? 1 : 0)}<span class="unit"> {row.units}</span>
							<span class="aq-cov" class:low={row.est.confidence === 'low'}>
								· {formatStationCount(row.est.contributingStations)}{fmtNearest(row.est.nearestKm)}
							</span>
						</dd>
					{/if}
				{/each}
			</dl>
		</section>
	{/if}

	{#if historyLoading || history}
		<section class="history" data-section="history" data-tier={tierOf('history')} style:order={orderOf('history')}>
			<h4>
				Station {history ? (HISTORY_LABELS[history.parameter] ?? history.parameter) : ''} history
				<HelpTooltip
					text="Measured, not modeled: recent hourly-aggregate readings from the single nearest OpenAQ ground sensor (not the diffused field). Only hours the sensor actually reported are drawn — missing hours stay gaps, never interpolated. The 24-h mean is the mean over the real samples only; the trend compares the newer half of the samples against the older half."
				>
					{#snippet trigger()}
						<span class="modeled-tag measured">measured</span>
					{/snippet}
				</HelpTooltip>
			</h4>
			{#if historyLoading && !history}
				<p class="loading">Fetching nearest-station history…</p>
			{:else if history && history.sampleCount === 0}
				<p class="note">No hourly samples in the last {fmtWindowHours(history)} h at the nearest station.</p>
			{:else if history}
				<div class="spark-row">
					<svg
						class="sparkline"
						width={SPARK_W}
						height={SPARK_H}
						viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
						role="img"
						aria-label={`${history.sampleCount} hourly samples over ${fmtWindowHours(history)} hours`}
					>
						{#if sparkPoints.length > 1}
							<path
								d={sparkPath}
								fill="none"
								stroke="var(--accent-amber)"
								stroke-width="1.25"
								stroke-linejoin="round"
							/>
						{/if}
						{#each sparkPoints as p (p.x)}
							<circle cx={p.x} cy={p.y} r="1.1" fill="var(--accent-amber)" />
						{/each}
					</svg>
					<div class="spark-stats">
						<span class="spark-mean">
							{#if history.mean === null}
								<span class="muted">—</span>
							{:else}
								{history.mean.toFixed(history.mean < 10 ? 1 : 0)}
							{/if}
							<span class="unit"> {history.units ?? 'µg/m³'}</span>
							<span class="trend trend-{history.trend}" aria-hidden="true">{TREND_GLYPH[history.trend]}</span>
						</span>
						<span class="spark-sub"
							>{fmtWindowHours(history)}-h mean · {history.sampleCount} samples · {history.trend}</span
						>
					</div>
				</div>
				<p class="note">
					Window {history.windowFrom.slice(0, 16).replace('T', ' ')}–{history.windowTo.slice(11, 16)}Z · nearest station
					{#if history.stale}· <span class="stale">stale ({history.latestAt?.slice(0, 10)})</span>{/if}
				</p>
			{/if}
		</section>
	{/if}

	{#if airQuality}
		<section data-section="pollen" data-tier={tierOf('pollen')} style:order={orderOf('pollen')}>
			<h4>
				Pollen &amp; air quality
				<HelpTooltip
					text="Modeled from the CAMS air-quality reanalysis/forecast (Open-Meteo), sampled at this point and hour. Pollen is in grains/m³; a species with no value is out of season or unsupported in this region (shown as “none reported”, not zero). AOD is the CAMS column aerosol optical depth; surface ozone is µg/m³ (not total-column Dobson)."
				>
					{#snippet trigger()}
						<span class="modeled-tag">modeled</span>
					{/snippet}
				</HelpTooltip>
			</h4>
			{#if reportedPollen.length > 0}
				<dl>
					{#each reportedPollen as species (species)}
						<dt>{POLLEN_LABELS[species]} pollen</dt>
						<dd>{airQuality.pollen[species]!.toFixed(0)}<span class="unit"> grains/m³</span></dd>
					{/each}
				</dl>
				{#if missingPollenCount > 0}
					<p class="note">{missingPollenCount} other species not in season — none reported.</p>
				{/if}
				{#if pollenTau && pollenTau.tau > 0}
					<p class="note">
						Optical depth τ ≈ {pollenTau.tau.toExponential(1)}{pollenTau.negligible
							? ' — negligible for transmission'
							: ''}
					</p>
				{/if}
			{:else}
				<p class="note">No pollen reported for this hour / region.</p>
			{/if}
			<dl>
				{#if airQuality.aod550 !== null}
					<dt>AOD₅₅₀</dt>
					<dd>{airQuality.aod550.toFixed(2)}</dd>
				{/if}
				{#if airQuality.dust !== null}
					<dt>Dust</dt>
					<dd>{airQuality.dust.toFixed(1)}<span class="unit"> µg/m³</span></dd>
				{/if}
				{#if airQuality.ozone !== null}
					<dt>Surface O₃</dt>
					<dd>{airQuality.ozone.toFixed(0)}<span class="unit"> µg/m³</span></dd>
				{/if}
			</dl>
			<p class="note">Hour {airQuality.matchedTime}Z · CC-BY Open-Meteo (CAMS)</p>
		</section>
	{/if}

	{#if crossValHasSignal}
		<section class="crossval" data-section="crossval" data-tier={tierOf('crossval')} style:order={orderOf('crossval')}>
			<h4>
				Source cross-check
				<HelpTooltip
					text="Lines up the air-quality sources at this point and reports their bias ONLY where both have data. Stations = OpenAQ ground PM2.5 (measured, then kernel-diffused); CAMS = modeled PM2.5 / column AOD. The Stations→AOD figure is an engineering bridge from surface PM2.5, not a measured column. A missing source is shown as no data — never as agreement. GIBS MODIS AOD is a visual cross-check on the map: there is no trustworthy point-decode in v1, so it is not compared numerically."
				>
					{#snippet trigger()}
						<span class="modeled-tag">derived</span>
					{/snippet}
				</HelpTooltip>
			</h4>
			{#if crossVal.pairs.length === 0}
				<p class="note">{crossVal.emptyReason}</p>
			{:else}
				<dl class="crossval-grid">
					{#each crossVal.pairs as pair (pair.quantity)}
						<dt>
							{pair.quantity === 'pm25' ? 'PM2.5' : 'AOD₅₅₀'}
							<span class="cv-level" class:conflict={pair.level === 'conflict'} class:differ={pair.level === 'differ'}>
								{pair.level}
							</span>
						</dt>
						<dd>
							Δ {pair.bias >= 0 ? '+' : ''}{pair.quantity === 'pm25'
								? pair.bias.toFixed(1)
								: pair.bias.toFixed(2)}{pair.units ? ` ${pair.units}` : ''}{pair.relDiff !== null
								? ` · ${Math.round(pair.relDiff * 100)}%`
								: ''}
						</dd>
						<dd class="cv-note">{pair.note}</dd>
					{/each}
				</dl>
				{#if crossVal.hasConflict}
					<p class="note cv-conflict-note">
						Sources disagree across a clean/unhealthy boundary — treat both with caution.
					</p>
				{/if}
			{/if}
			<p class="note">Numeric: OpenAQ ↔ CAMS only. GIBS MODIS AOD is a visual cross-check (no point-decode in v1).</p>
		</section>
	{/if}

	<section
		class="ephemeris-section"
		data-section="ephemeris"
		data-tier={tierOf('ephemeris')}
		style:order={orderOf('ephemeris')}
	>
		<button
			class="ephemeris-header"
			type="button"
			aria-expanded={ephemerisOpen}
			aria-controls="pin-ephemeris-body"
			onclick={toggleEphemeris}
		>
			<span class="caret" aria-hidden="true">{ephemerisOpen ? '▾' : '▸'}</span>
			<span>Horizon-aware ephemeris</span>
		</button>
		{#if ephemerisOpen}
			<div id="pin-ephemeris-body" class="ephemeris-body">
				{#if ephemerisLoading}
					<p class="loading">Tracing local horizon…</p>
					<p class="note">Fetching elevation tiles + raycasting 36 azimuths. First open takes a few seconds.</p>
				{:else if ephemerisError}
					<p class="error">{ephemerisError}</p>
				{:else if ephemeris}
					{@const r = ephemeris.refined}
					{@const f = ephemeris.flat.events}
					<dl class="events">
						<dt>Astro dawn</dt>
						<dd>
							{fmtClock(r.astronomicalDawn)}<span class="delta">{deltaMin(f.astronomicalDawn, r.astronomicalDawn)}</span
							>
						</dd>
						<dt>Nautical dawn</dt>
						<dd>{fmtClock(r.nauticalDawn)}<span class="delta">{deltaMin(f.nauticalDawn, r.nauticalDawn)}</span></dd>
						<dt>Civil dawn</dt>
						<dd>{fmtClock(r.civilDawn)}<span class="delta">{deltaMin(f.civilDawn, r.civilDawn)}</span></dd>
						<dt>Sunrise</dt>
						<dd>{fmtClock(r.sunrise)}<span class="delta">{deltaMin(f.sunrise, r.sunrise)}</span></dd>
						<dt>Sunset</dt>
						<dd>{fmtClock(r.sunset)}<span class="delta">{deltaMin(f.sunset, r.sunset)}</span></dd>
						<dt>Civil dusk</dt>
						<dd>{fmtClock(r.civilDusk)}<span class="delta">{deltaMin(f.civilDusk, r.civilDusk)}</span></dd>
						<dt>Nautical dusk</dt>
						<dd>{fmtClock(r.nauticalDusk)}<span class="delta">{deltaMin(f.nauticalDusk, r.nauticalDusk)}</span></dd>
						<dt>Astro dusk</dt>
						<dd>
							{fmtClock(r.astronomicalDusk)}<span class="delta">{deltaMin(f.astronomicalDusk, r.astronomicalDusk)}</span
							>
						</dd>
					</dl>
					<p class="note">
						UTC · (±m) = shift vs flat horizon at this pin. Terrain from Mapzen Terrarium z=12 · {ephemeris.fans.length}
						dense {ephemeris.fans.length === 1 ? 'fan' : 'fans'} at the sun's event azimuths.
					</p>
				{:else}
					<p class="note">Click to compute terrain-aware twilight times for this pin.</p>
				{/if}
			</div>
		{/if}
	</section>

	{#snippet transmissionCta()}
		{#if onTransmissionForPoint && data?.atmospheric}
			<button
				type="button"
				class="transmission-link"
				data-cta="transmission"
				data-tier={ctaTier('transmission')}
				aria-label="Open spectral transmission analysis for this point — T(λ), AOD, Ångström, and a directable laser/EO/RF boresight"
				onclick={onTransmissionForPoint}
			>
				<span class="cta-text">
					<span class="cta-label">Spectral transmission T(λ)</span>
					<span class="cta-sub">directable boresight · AOD · band guidance</span>
				</span>
				<span class="cta-caret" aria-hidden="true">→</span>
			</button>
		{/if}
	{/snippet}

	{#snippet aqDashboardCta()}
		{#if onAqDashboardForPoint && data}
			<button
				type="button"
				class="transmission-link aq-dashboard-link"
				data-cta="aq"
				data-tier={ctaTier('aq')}
				aria-label="Open the air-quality analysis dashboard for this point — time-series history, multi-pollutant AQI, and source cross-validation"
				onclick={onAqDashboardForPoint}
			>
				<span class="cta-text">
					<span class="cta-label">Air-quality dashboard</span>
					<span class="cta-sub">history · multi-pollutant AQI · source cross-check</span>
				</span>
				<span class="cta-caret" aria-hidden="true">→</span>
			</button>
		{/if}
	{/snippet}

	{#snippet passCta()}
		{#if onPlanPassForPoint && data}
			<button
				type="button"
				class="transmission-link pass-plan-link"
				data-cta="pass"
				data-tier={ctaTier('pass')}
				aria-label="Plan a satellite pass for this point — SGP4 passes gated by the local terrain horizon, with an az/el track and Doppler"
				onclick={onPlanPassForPoint}
			>
				<span class="cta-text">
					<span class="cta-label">Plan a pass</span>
					<span class="cta-sub">DEM-gated AOS/LOS · az/el track · Doppler</span>
				</span>
				<span class="cta-caret" aria-hidden="true">→</span>
			</button>
		{/if}
	{/snippet}

	<!-- Promoted CTA first so Tab order matches visual order (WCAG 2.4.3). -->
	{#if primaryCta === 'pass'}
		{@render passCta()}
		{@render transmissionCta()}
		{@render aqDashboardCta()}
	{:else if primaryCta === 'aq'}
		{@render aqDashboardCta()}
		{@render transmissionCta()}
		{@render passCta()}
	{:else}
		{@render transmissionCta()}
		{@render aqDashboardCta()}
		{@render passCta()}
	{/if}
</div>

<style>
	.readout {
		position: fixed;
		bottom: 4rem;
		right: 1rem;
		min-width: 16rem;
		max-width: 22rem;
		padding: 1rem 1.25rem;
		background: rgba(8, 10, 16, 0.92);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		box-sizing: border-box;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85rem;
		z-index: 11;
		backdrop-filter: blur(8px);
		animation: slide-up 0.18s ease-out;
		/* Flex column so the active lens can float its lead section to the top
		   and dim off-lens ones via `order` + `data-tier` (S1 PR4). */
		display: flex;
		flex-direction: column;
	}
	/* Header always leads; the lens only reorders the data sections below it. */
	.readout > header {
		order: -100;
	}
	/* Off-lens sections dim but stay fully interactive — re-weight, never gate.
	   No aria-disabled / display:none / pointer-events:none anywhere. */
	.readout > [data-tier='3'] {
		opacity: var(--readout-tier3-opacity, 0.55);
	}
	.readout > [data-tier='1'] {
		opacity: 1;
	}
	/* Two-channel tier signal (§11.3): off-lens value text drops the amber accent
	   to neutral ink, and Tier-3 also lightens weight — emphasis survives even
	   before the opacity dim, so no single channel carries the whole hierarchy.
	   Tier-1 keeps amber; .aqi-value keeps its category colour; .bortle-class
	   (the Sky lead) stays amber. */
	.readout > [data-tier='2'] :where(.value, .spark-mean, .atmos-grid dd, .events dd, .crossval-grid dd),
	.readout > [data-tier='3'] :where(.value, .spark-mean, .atmos-grid dd, .events dd, .crossval-grid dd) {
		color: #e9ecf3;
	}
	.readout > [data-tier='3'] :where(.value, .spark-mean) {
		font-weight: 500;
	}
	/* Stop descendant fades compounding under the Tier-3 0.55 opacity (keeps faint
	   sub-text above the 4.5:1 contrast floor). */
	.readout > [data-tier='3'] :where(.note, .coverage, .aq-cov, .cv-level, .aqi-dom, .cta-sub, .spark-sub, .cv-note) {
		opacity: 0.9;
	}
	/* Non-promoted CTAs read as available-but-secondary (ghost), not a Tier-1 peer.
	   The Tier-3 opacity layer above still applies to the off-lens CTA. */
	.readout > [data-cta][data-tier='3'] {
		background: transparent;
		border-color: rgba(var(--accent-amber-rgb), 0.18);
	}
	.readout > [data-cta][data-tier='3'] .cta-label {
		font-weight: 500;
	}
	/* Lens-diff cross-fade: only the dim/emphasis transitions (opacity), never
	   the map or layout. Reordering is instant; the tier change eases. */
	.readout > [data-section],
	.readout > [data-cta] {
		transition: opacity var(--lens-diff-ms, 200ms) ease;
	}
	@media (prefers-reduced-motion: reduce) {
		.readout > [data-section],
		.readout > [data-cta] {
			transition: none;
		}
	}
	.bortle-lead {
		margin-bottom: 0.5rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	}
	.bortle-class {
		margin: 0;
		font-size: 1.5rem;
		font-weight: 700;
		line-height: 1.05;
		color: var(--accent-amber);
	}
	.bortle-label {
		display: block;
		margin-top: 0.1rem;
		font-size: 0.78rem;
		font-weight: 400;
		opacity: 0.75;
		color: #e9ecf3;
	}
	.bortle-sqm {
		margin: 0.25rem 0 0;
		font-size: 0.8rem;
		opacity: 0.85;
	}
	@keyframes slide-up {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	.transmission-link {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		width: 100%;
		margin: 0.7rem 0 0;
		padding: 0.55rem 0.7rem;
		background: rgba(var(--accent-amber-rgb), 0.08);
		border: 1px solid rgba(var(--accent-amber-rgb), 0.3);
		border-radius: 7px;
		color: var(--accent-amber);
		cursor: pointer;
		text-align: left;
		font-family: inherit;
		transition: background 0.12s ease;
	}
	.transmission-link:hover,
	.transmission-link:focus-visible {
		background: rgba(var(--accent-amber-rgb), 0.16);
	}
	/* Keep a real keyboard focus ring (was suppressed by outline:none). */
	.transmission-link:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 2px;
	}
	.transmission-link .cta-text {
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		min-width: 0;
		line-height: 1.25;
	}
	.transmission-link .cta-label {
		font-size: 0.78rem;
		font-weight: 600;
	}
	.transmission-link .cta-sub {
		font-size: 0.66rem;
		opacity: 0.7;
	}
	.transmission-link .cta-caret {
		flex: 0 0 auto;
		opacity: 0.6;
		font-size: 0.95rem;
	}
	.close {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		background: none;
		border: none;
		color: rgba(233, 236, 243, 0.55);
		font-size: 1rem;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
	}
	.close:hover {
		color: var(--accent-amber);
	}
	.close:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 2px;
		color: var(--accent-amber);
	}
	header h3 {
		margin: 0 0 0.15rem 0;
		font-size: 0.95rem;
	}
	header p {
		margin: 0 0 0.75rem 0;
		opacity: 0.6;
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}
	header .locator {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		opacity: 0.78;
	}
	.locator-mark {
		color: var(--accent-amber);
		flex: 0 0 auto;
	}
	section {
		margin-top: 0.85rem;
		padding-top: 0.65rem;
		border-top: 1px solid rgba(255, 255, 255, 0.06);
	}
	section h4 {
		display: block;
		margin: 0 0 0.25rem 0;
		font-size: 0.7rem;
		line-height: 1.2;
		min-height: 0.84rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		opacity: 0.65;
	}
	.value {
		margin: 0;
		font-size: 1.3rem;
		font-weight: 600;
		color: var(--accent-amber);
		font-variant-numeric: tabular-nums;
	}
	.unit {
		font-size: 0.75rem;
		opacity: 0.7;
		font-weight: 400;
		margin-left: 0.2rem;
	}
	.note {
		margin: 0.25rem 0 0 0;
		font-size: 0.72rem;
		opacity: 0.7;
	}
	.modeled-tag {
		margin-left: 0.35rem;
		padding: 0.02rem 0.3rem;
		border-radius: 999px;
		border: 1px solid rgba(127, 187, 255, 0.4);
		background: rgba(127, 187, 255, 0.12);
		color: #c7ddff;
		font-size: 0.55rem;
		letter-spacing: 0.04em;
		vertical-align: middle;
	}
	.modeled-tag.measured {
		border-color: rgba(120, 220, 160, 0.4);
		background: rgba(120, 220, 160, 0.12);
		color: #b8f0cf;
	}
	.spark-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-top: 0.15rem;
	}
	.sparkline {
		flex: 0 0 auto;
		overflow: visible;
	}
	.spark-stats {
		display: flex;
		flex-direction: column;
		line-height: 1.2;
		min-width: 0;
	}
	.spark-mean {
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--accent-amber);
		font-variant-numeric: tabular-nums;
	}
	.spark-mean .muted {
		color: rgba(233, 236, 243, 0.62);
	}
	.spark-sub {
		font-size: 0.66rem;
		opacity: 0.6;
	}
	.trend {
		margin-left: 0.2rem;
		font-size: 0.9rem;
	}
	.trend-rising {
		color: #ff8c6b;
	}
	.trend-falling {
		color: #7fdca0;
	}
	.trend-flat {
		opacity: 0.6;
	}
	.stale {
		color: var(--accent-amber);
		opacity: 0.9;
	}
	.coverage {
		opacity: 0.6;
	}
	.coverage.low {
		color: var(--accent-amber);
		opacity: 0.85;
	}
	.aq-cov {
		font-size: 0.62rem;
		opacity: 0.5;
	}
	.aq-cov.low {
		color: var(--accent-amber);
		opacity: 0.8;
	}
	.aqi-badge {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.4rem 0.6rem;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--aqi-color) 55%, transparent);
		background: color-mix(in srgb, var(--aqi-color) 14%, transparent);
	}
	.aqi-value {
		font-size: 1.4rem;
		font-weight: 700;
		line-height: 1;
		color: var(--aqi-color);
		font-variant-numeric: tabular-nums;
	}
	.aqi-meta {
		display: flex;
		flex-direction: column;
		line-height: 1.2;
	}
	.aqi-cat {
		font-size: 0.78rem;
		font-weight: 600;
	}
	.aqi-dom {
		font-size: 0.66rem;
		opacity: 0.7;
	}
	.crossval-grid {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.15rem 0.75rem;
		margin: 0;
		font-size: 0.74rem;
		font-variant-numeric: tabular-nums;
	}
	.crossval-grid dt {
		opacity: 0.8;
	}
	.crossval-grid dd {
		margin: 0;
		text-align: right;
		color: var(--accent-amber);
	}
	.crossval-grid dd.cv-note {
		grid-column: 1 / -1;
		text-align: left;
		color: rgba(233, 236, 243, 0.7);
		font-size: 0.66rem;
		margin-bottom: 0.2rem;
	}
	.cv-level {
		margin-left: 0.3rem;
		font-size: 0.58rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		opacity: 0.6;
	}
	.cv-level.differ {
		color: var(--accent-amber);
		opacity: 0.9;
	}
	.cv-level.conflict {
		color: #ff6b6b;
		opacity: 1;
		font-weight: 600;
	}
	.cv-conflict-note {
		color: #ff8f8f;
		opacity: 0.9;
	}
	.loading {
		opacity: 0.55;
		font-style: italic;
		margin: 0.5rem 0 0 0;
	}
	.error {
		color: #ff6b6b;
		margin: 0.5rem 0 0 0;
	}
	.ephemeris-section {
		margin-top: 0.85rem;
		padding-top: 0.65rem;
		border-top: 1px solid rgba(255, 255, 255, 0.06);
	}
	.ephemeris-header {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		width: 100%;
		background: none;
		border: none;
		padding: 0;
		color: rgba(233, 236, 243, 0.85);
		font: inherit;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		cursor: pointer;
		text-align: left;
	}
	.ephemeris-header:hover {
		color: var(--accent-amber);
	}
	.ephemeris-header:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 2px;
		color: var(--accent-amber);
	}
	.caret {
		display: inline-block;
		width: 0.7rem;
		opacity: 0.75;
	}
	.ephemeris-body {
		margin-top: 0.5rem;
	}
	.events {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.15rem 0.75rem;
		margin: 0;
		font-variant-numeric: tabular-nums;
		font-size: 0.78rem;
	}
	.events dt {
		opacity: 0.7;
	}
	.events dd {
		margin: 0;
		text-align: right;
		color: var(--accent-amber);
	}
	.atmos-grid {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.2rem 0.75rem;
		margin: 0;
		font-size: 0.78rem;
		font-variant-numeric: tabular-nums;
	}
	.atmos-grid dt {
		opacity: 0.7;
	}
	.atmos-grid dd {
		margin: 0;
		text-align: right;
		color: var(--accent-amber);
	}
	.atmos-grid dd .muted {
		color: rgba(233, 236, 243, 0.62);
	}
	.delta {
		margin-left: 0.3rem;
		opacity: 0.65;
		color: #e9ecf3;
	}
	@media (max-width: 820px), (max-height: 500px) {
		.readout {
			left: 0.75rem;
			right: calc(var(--map-toolbar-inset-rem, 5rem) + 0.75rem);
			bottom: calc(var(--field-bottom-reserve, 7.75rem) + env(safe-area-inset-bottom, 0px) + 6.25rem);
			min-width: 0;
			max-width: none;
			max-height: calc(100vh - var(--field-bottom-reserve, 7.75rem) - env(safe-area-inset-bottom, 0px) - 7.5rem);
			max-height: calc(100dvh - var(--field-bottom-reserve, 7.75rem) - env(safe-area-inset-bottom, 0px) - 7.5rem);
			overflow-y: auto;
			padding: 0.9rem 1rem 1rem;
		}
		.close {
			top: 0.25rem;
			right: 0.25rem;
			min-width: 2.75rem;
			min-height: 2.75rem;
		}
		.ephemeris-header {
			min-height: 2.75rem;
		}
	}
</style>
