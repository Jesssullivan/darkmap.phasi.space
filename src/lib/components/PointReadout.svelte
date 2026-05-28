<script lang="ts">
	import { X } from '@lucide/svelte';
	import type { PinEphemerisReadout } from '$lib/ephemeris/pinEphemeris';

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
		onclose: () => void;
	}

	let { lat, lon, time, data, loading, error, onclose }: Props = $props();

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

<div class="readout" role="dialog" aria-label="Point readout">
	<button class="close" type="button" aria-label="Close readout" onclick={onclose}>
		<X size={16} aria-hidden="true" />
	</button>
	<header>
		<h3>Point readout</h3>
		<p>{fmtCoord(lat)}°, {fmtCoord(lon)}°</p>
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
		color: #ffd166;
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
		color: #ffd166;
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
		color: #ffd166;
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
		color: #ffd166;
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
		color: #ffd166;
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
			bottom: calc(var(--field-bottom-reserve, 7.75rem) + env(safe-area-inset-bottom, 0px) + 0.75rem);
			min-width: 0;
			max-width: none;
			max-height: calc(100dvh - var(--field-bottom-reserve, 7.75rem) - 2rem);
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
