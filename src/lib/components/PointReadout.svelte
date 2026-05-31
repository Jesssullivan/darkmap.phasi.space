<script lang="ts">
	import { X } from '@lucide/svelte';
	import HelpTooltip from '$lib/components/HelpTooltip.svelte';
	import type { PinEphemerisReadout } from '$lib/ephemeris/pinEphemeris';
	import {
		formatNearestKm,
		formatStationCount,
		pm25AqiCategory,
		type Pm25Estimate,
	} from '$lib/atmospheric/pm25-diffusion';
	import {
		POLLEN_SPECIES,
		type AirQualityPointReading,
		type PollenReading,
	} from '$lib/effect/services/AirQualityService';
	import { pollenOpticalDepth } from '$lib/atmospheric/pollen-extinction';

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
		onclose: () => void;
		/**
		 * Open the spectral-transmission sheet seeded from THIS point + time.
		 * The transmission tool is point-anchored (V3): the boresight geometry,
		 * PWV, and AOD all derive from the selected location, so the entry point
		 * lives here rather than as an independent rail CTA.
		 */
		onTransmissionForPoint?: () => void;
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
		onclose,
		onTransmissionForPoint,
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
	const waClass = $derived.by(() => {
		const g = data?.worldAtlas?.grayIndex;
		if (g === undefined) return undefined;
		if (g < 1) return 'Pristine';
		if (g < 8) return 'Wilderness';
		if (g < 32) return 'Rural';
		if (g < 87) return 'Suburban';
		if (g < 460) return 'Urban';
		return 'Inner city';
	});

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

<div bind:this={readoutPanel} class="readout" role="dialog" aria-label="Point readout">
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
	{#if loading}
		<p class="loading">Querying upstream…</p>
	{:else if error}
		<p class="error">Error: {error}</p>
	{:else if data}
		{#if data.viirs}
			<section>
				<h4>VIIRS pixel</h4>
				<p class="value">{viirsAvg}<span class="unit">/255</span></p>
				<p class="note">{data.viirs.layer} · RGB({data.viirs.red},{data.viirs.green},{data.viirs.blue})</p>
			</section>
		{/if}
		{#if data.worldAtlas}
			<section>
				<h4>World Atlas radiance</h4>
				<p class="value">{data.worldAtlas.grayIndex.toFixed(2)}<span class="unit"> mcd/m²</span></p>
				{#if waClass}
					<p class="note">Falchi 2016: <strong>{waClass}</strong></p>
				{/if}
			</section>
		{/if}
		{#if data.atmospheric}
			<section>
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

	{#if pm25 && pm25.valueUgm3 !== null}
		<section>
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
		<section>
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

	{#if airQuality}
		<section>
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

	<section class="ephemeris-section">
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

	{#if onTransmissionForPoint && data?.atmospheric}
		<button
			type="button"
			class="transmission-link"
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
		outline: none;
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
		margin: 0 0 0.25rem 0;
		font-size: 0.7rem;
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
	@media (max-width: 820px) {
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
