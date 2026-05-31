<script lang="ts">
	/**
	 * TransmissionSheet — bottom sheet that surfaces an atmospheric
	 * transmission curve T(λ) for the user's current pin or map center,
	 * using the active atmospheric inputs (PWV, AOD, O₃, zenith).
	 *
	 * Opens from the `(i)` chevron on any atmospheric LayerRail row
	 * (PR-H). The chart is inline SVG so we don't pull in a chart
	 * library; log-scale x-axis, linear y-axis 0..1, visible-band
	 * (0.4–0.7 µm) lightly shaded for orientation.
	 *
	 * V0 disclaimer: the underlying LUT is an analytical engineering
	 * estimate (PR-G). PR-G2 will swap in SMARTS + SBDART output
	 * without touching this widget.
	 */
	import { X } from '@lucide/svelte';
	import type { TransmissionCurve } from '$lib/effect/services/TransmissionEstimator';
	import type { BandCurve } from '$lib/effect/services/LineByLineService';
	import { AEROSOL_TYPES, aerosolEntry, type AerosolType } from '$lib/spectral/aerosol-types';
	import { findHitranBand, HITRAN_BANDS } from '$lib/spectral/hitran-bands';
	import { bandGuidance } from '$lib/spectral/band-guidance';
	import HelpTooltip from '$lib/components/HelpTooltip.svelte';

	interface Props {
		curve: TransmissionCurve | undefined;
		loading: boolean;
		error?: string;
		onclose: () => void;
		// V2-D — live-aerosol controls. Parent owns the state; widget emits.
		aerosolType?: AerosolType | null;
		aod?: number;
		/** Optional caption shown under the AOD slider when AOD is modeled (e.g. from local PM2.5). #275 */
		aodSource?: string;
		angstrom?: number;
		onAerosolTypeChange?: (value: AerosolType | null) => void;
		onAodChange?: (value: number) => void;
		onAngstromChange?: (value: number) => void;
		// V3b-4 — band zoom controls. Parent owns selected-band state + curve.
		selectedBandId?: string | null;
		bandCurve?: BandCurve | undefined;
		bandLoading?: boolean;
		bandError?: string;
		onBandSelect?: (bandId: string | null) => void;
	}

	let {
		curve,
		loading,
		error,
		onclose,
		aerosolType = null,
		aod = 0.15,
		aodSource = undefined,
		angstrom = 1.4,
		onAerosolTypeChange,
		onAodChange,
		onAngstromChange,
		selectedBandId = null,
		bandCurve = undefined,
		bandLoading = false,
		bandError = undefined,
		onBandSelect,
	}: Props = $props();

	const WIDTH = 360;
	const HEIGHT = 200;
	const PAD = { left: 36, right: 12, top: 12, bottom: 28 };
	const PLOT_W = WIDTH - PAD.left - PAD.right;
	const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

	const TICK_LAMBDAS_UM = [0.3, 0.5, 1, 2, 5, 10, 20];

	const logMin = Math.log10(0.3);
	const logMax = Math.log10(30);

	const xForLambda = (um: number): number => PAD.left + ((Math.log10(um) - logMin) / (logMax - logMin)) * PLOT_W;
	const yForT = (t: number): number => PAD.top + (1 - t) * PLOT_H;

	const polyline = $derived.by(() => {
		if (!curve) return '';
		const pts: string[] = [];
		for (let i = 0; i < curve.wavelengthsUm.length; i++) {
			const x = xForLambda(curve.wavelengthsUm[i]);
			const y = yForT(curve.transmission[i]);
			pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
		}
		return pts.join(' ');
	});

	const visibleBand = $derived.by(() => {
		const x0 = xForLambda(0.4);
		const x1 = xForLambda(0.7);
		return { x: x0, width: x1 - x0 };
	});

	const fmt = (n: number, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : '—');

	// Plain-language takeaway distilled from the curve (#PR4): clearest window
	// to work in + worst absorption band to avoid.
	const guidance = $derived(curve ? bandGuidance(curve) : null);

	// Live-Mie mode derives the Ångström exponent from the aerosol model, so the
	// slider is disabled — show the derived value (not the stale prop) so it reads
	// as "computed", not "broken".
	const angstromLocked = $derived(aerosolType !== null);
	const angstromDisplay = $derived(angstromLocked ? (curve?.input.angstrom ?? angstrom) : angstrom);

	// Band / frequency quick-select (#250 first step): operational laser lines +
	// EO atmospheric windows. Clicking one reads T(λ) straight off the curve so a
	// user can answer "does my band get through tonight?" without reading the plot.
	interface BandPreset {
		readonly id: string;
		readonly label: string;
		readonly sub: string;
		readonly loUm: number;
		readonly hiUm: number;
	}
	const BAND_PRESETS: ReadonlyArray<BandPreset> = [
		{ id: 'green-532', label: '532 nm', sub: 'green laser', loUm: 0.532, hiUm: 0.532 },
		{ id: 'ndyag-1064', label: '1064 nm', sub: 'Nd:YAG', loUm: 1.064, hiUm: 1.064 },
		{ id: 'eyesafe-1550', label: '1550 nm', sub: 'eye-safe', loUm: 1.55, hiUm: 1.55 },
		{ id: 'vis', label: 'VIS', sub: '0.4–0.7 µm', loUm: 0.4, hiUm: 0.7 },
		{ id: 'swir', label: 'SWIR', sub: '1–2.5 µm', loUm: 1.0, hiUm: 2.5 },
		{ id: 'mwir', label: 'MWIR', sub: '3–5 µm', loUm: 3.0, hiUm: 5.0 },
		{ id: 'lwir', label: 'LWIR', sub: '8–12 µm', loUm: 8.0, hiUm: 12.0 },
	];
	let selectedPresetId = $state<string | null>(null);

	/** Linear-interpolate T at a wavelength (µm) from the sorted curve. */
	const transmissionAt = (c: TransmissionCurve, um: number): number | null => {
		const w = c.wavelengthsUm;
		const t = c.transmission;
		if (w.length === 0 || um < w[0] || um > w[w.length - 1]) return null;
		for (let i = 1; i < w.length; i++) {
			if (um <= w[i]) {
				const span = w[i] - w[i - 1];
				const f = span === 0 ? 0 : (um - w[i - 1]) / span;
				return t[i - 1] + f * (t[i] - t[i - 1]);
			}
		}
		return t[t.length - 1];
	};
	const bandMeanT = (c: TransmissionCurve, lo: number, hi: number): number | null => {
		if (lo === hi) return transmissionAt(c, lo);
		let sum = 0;
		let n = 0;
		for (let i = 0; i < c.wavelengthsUm.length; i++) {
			const um = c.wavelengthsUm[i];
			if (um >= lo && um <= hi) {
				sum += c.transmission[i];
				n += 1;
			}
		}
		return n > 0 ? sum / n : transmissionAt(c, (lo + hi) / 2);
	};
	const presetReadout = $derived.by(() => {
		if (!curve || selectedPresetId === null) return null;
		const p = BAND_PRESETS.find((b) => b.id === selectedPresetId);
		if (!p) return null;
		const t = bandMeanT(curve, p.loUm, p.hiUm);
		if (t === null) return { preset: p, t: null, verdict: 'out of range', markerUm: (p.loUm + p.hiUm) / 2 };
		const verdict = t >= 0.7 ? 'clear' : t >= 0.4 ? 'marginal' : 'blocked';
		return { preset: p, t, verdict, markerUm: (p.loUm + p.hiUm) / 2 };
	});
</script>

<div class="sheet" role="dialog" aria-label="Atmospheric transmission widget">
	<header>
		<h3>Atmospheric transmission</h3>
		<button class="close" type="button" aria-label="Close transmission sheet" onclick={onclose}>
			<X size={16} aria-hidden="true" />
		</button>
	</header>

	{#if loading}
		<p class="loading">Computing T(λ)…</p>
	{:else if error}
		<p class="error">Error: {error}</p>
	{:else if curve}
		<!-- V2-D: aerosol picker + live recompute controls. "Off" leaves the
		LUT-only analytical path active; any other choice switches to live Mie. -->
		<div class="aerosol-picker" role="radiogroup" aria-label="Aerosol type">
			<button
				type="button"
				class="aerosol-chip"
				class:active={aerosolType === null}
				aria-pressed={aerosolType === null}
				onclick={() => onAerosolTypeChange?.(null)}>Off</button
			>
			{#each AEROSOL_TYPES as type (type)}
				<button
					type="button"
					class="aerosol-chip"
					class:active={aerosolType === type}
					aria-pressed={aerosolType === type}
					title={aerosolEntry(type).description}
					onclick={() => onAerosolTypeChange?.(type)}>{aerosolEntry(type).label.split(' ')[0]}</button
				>
			{/each}
		</div>

		<div class="slider-row">
			<label>
				<span class="slider-label"
					>AOD<sub>550</sub>
					<HelpTooltip
						positioning="top"
						text="Aerosol optical depth at 550 nm — how much haze, smoke, or dust the path carries. ~0.05 pristine, ~0.2 average, &gt;0.5 hazy. Higher means more scattering and dimmer transmission."
					>
						{#snippet trigger()}<span class="param-help" role="img" aria-label="About AOD">?</span>{/snippet}
					</HelpTooltip></span
				>
				<input
					type="range"
					min="0"
					max="2"
					step="0.05"
					value={aod}
					aria-label="AOD550 slider"
					oninput={(e) => onAodChange?.(Number((e.target as HTMLInputElement).value))}
				/>
				<span class="slider-value">{aod.toFixed(2)}</span>
			</label>
			{#if aodSource}
				<p class="aod-source">{aodSource}</p>
			{/if}
		</div>
		<div class="slider-row">
			<label>
				<span class="slider-label"
					>Ångström α
					<HelpTooltip
						positioning="top"
						text="Ångström exponent — how strongly aerosol scattering varies with wavelength. Low (~0.5) means large particles (dust, sea salt) scattering broadband; high (~1.5–2) means fine particles (smoke, urban haze) hitting shorter wavelengths harder."
					>
						{#snippet trigger()}<span class="param-help" role="img" aria-label="About the Ångström exponent">?</span
							>{/snippet}
					</HelpTooltip></span
				>
				<input
					type="range"
					min="0.3"
					max="2.5"
					step="0.1"
					value={angstromDisplay}
					disabled={angstromLocked}
					aria-label="Ångström exponent slider"
					oninput={(e) => onAngstromChange?.(Number((e.target as HTMLInputElement).value))}
				/>
				<span class="slider-value"
					>{angstromDisplay.toFixed(1)}{#if angstromLocked}<span
							class="derived-tag"
							title="Derived from the live Mie aerosol model — set the aerosol type to “Off” to adjust Ångström manually"
							>Mie</span
						>{/if}</span
				>
			</label>
		</div>

		<dl class="inputs">
			<dt>
				PWV
				<HelpTooltip
					positioning="top"
					text="Precipitable water vapor — total water in the atmospheric column (mm). The main driver of the infrared absorption bands; lower PWV opens up the SWIR/MWIR windows. From the Open-Meteo point reading."
				>
					{#snippet trigger()}<span class="param-help" role="img" aria-label="About PWV">?</span>{/snippet}
				</HelpTooltip>
			</dt>
			<dd>{fmt(curve.input.pwvMm, 1)}<span class="unit"> mm</span></dd>
			<dt>AOD₅₅₀</dt>
			<dd>{fmt(curve.input.aod550, 2)}</dd>
			<dt>Ångström</dt>
			<dd>{fmt(curve.input.angstrom, 1)}</dd>
			<dt>O₃</dt>
			<dd>{fmt(curve.input.o3Du, 0)}<span class="unit"> DU</span></dd>
			<dt>Zenith</dt>
			<dd>{fmt(curve.input.zenithDeg, 0)}°</dd>
		</dl>

		<svg
			role="img"
			aria-label="Transmission curve from 0.3 to 30 µm"
			class="chart"
			viewBox="0 0 {WIDTH} {HEIGHT}"
			preserveAspectRatio="xMidYMid meet"
		>
			<!-- visible-band shading -->
			<rect x={visibleBand.x} y={PAD.top} width={visibleBand.width} height={PLOT_H} fill="rgba(255, 209, 102, 0.08)"
			></rect>

			<!-- axes -->
			<line x1={PAD.left} y1={PAD.top + PLOT_H} x2={PAD.left + PLOT_W} y2={PAD.top + PLOT_H} class="axis"></line>
			<line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + PLOT_H} class="axis"></line>

			<!-- y-axis labels (T = 0, 0.5, 1) -->
			{#each [0, 0.5, 1] as t (t)}
				<line x1={PAD.left} x2={PAD.left + PLOT_W} y1={yForT(t)} y2={yForT(t)} class="grid" stroke-dasharray="2,3"
				></line>
				<text x={PAD.left - 6} y={yForT(t) + 3} class="label-y" text-anchor="end">{t.toFixed(1)}</text>
			{/each}

			<!-- x-axis ticks -->
			{#each TICK_LAMBDAS_UM as um (um)}
				<line x1={xForLambda(um)} x2={xForLambda(um)} y1={PAD.top + PLOT_H} y2={PAD.top + PLOT_H + 3} class="axis"
				></line>
				<text x={xForLambda(um)} y={PAD.top + PLOT_H + 14} class="label-x" text-anchor="middle">{um}</text>
			{/each}
			<text x={PAD.left + PLOT_W / 2} y={PAD.top + PLOT_H + 24} class="axis-title" text-anchor="middle"
				>λ (µm) · log</text
			>

			<!-- curve -->
			<polyline points={polyline} class="curve" fill="none"></polyline>

			<!-- V3b-4: band-tick markers above the x-axis. Clicking the chip below
			the chart opens the detail panel; the tick itself is just a visual cue. -->
			{#each HITRAN_BANDS as band (band.id)}
				<line
					x1={xForLambda(band.centerUm)}
					x2={xForLambda(band.centerUm)}
					y1={PAD.top}
					y2={PAD.top + PLOT_H}
					class="band-tick"
				></line>
			{/each}

			<!-- Quick-select band marker — where the chosen laser/EO band sits. -->
			{#if presetReadout && presetReadout.markerUm >= 0.3 && presetReadout.markerUm <= 30}
				<line
					x1={xForLambda(presetReadout.markerUm)}
					x2={xForLambda(presetReadout.markerUm)}
					y1={PAD.top}
					y2={PAD.top + PLOT_H}
					class="preset-marker"
				></line>
			{/if}
		</svg>

		<!-- The "pick a working band tonight" payload — surfaced as a prominent
		     callout + a direct laser/EO quick-select, not left to chart-reading. -->
		{#if guidance && (guidance.clearest || guidance.worst)}
			<div class="band-guidance" role="note">
				<p class="band-guidance-takeaway">
					<span class="band-guidance-icon" aria-hidden="true">◎</span>{guidance.takeaway}
				</p>
				<div class="band-guidance-stats">
					{#if guidance.clearest}
						<span class="bg-stat clear"
							>Clearest {guidance.clearest.loUm.toFixed(2)}–{guidance.clearest.hiUm.toFixed(2)} µm · T̄ {(
								guidance.clearest.meanT * 100
							).toFixed(0)}%</span
						>
					{/if}
					{#if guidance.worst}
						<span class="bg-stat worst">Avoid {guidance.worst.label} · T {(guidance.worst.minT * 100).toFixed(0)}%</span
						>
					{/if}
				</div>
			</div>
		{/if}

		<div class="band-presets" role="group" aria-label="Laser / EO band quick-select">
			<span class="band-presets-label">Check a band</span>
			<div class="band-presets-chips">
				{#each BAND_PRESETS as p (p.id)}
					<button
						type="button"
						class="preset-chip"
						class:active={selectedPresetId === p.id}
						aria-pressed={selectedPresetId === p.id}
						title="{p.sub} · {p.loUm === p.hiUm ? `${p.loUm} µm` : `${p.loUm}–${p.hiUm} µm`}"
						onclick={() => (selectedPresetId = selectedPresetId === p.id ? null : p.id)}>{p.label}</button
					>
				{/each}
			</div>
			{#if presetReadout}
				<p class="preset-readout verdict-{presetReadout.verdict.replace(' ', '-')}">
					<strong>{presetReadout.preset.label}</strong>
					<span class="preset-sub">{presetReadout.preset.sub}</span> —
					{#if presetReadout.t !== null}
						T ≈ {(presetReadout.t * 100).toFixed(0)}% · <span class="verdict">{presetReadout.verdict}</span>
					{:else}
						outside the modeled range
					{/if}
				</p>
			{/if}
		</div>

		<!-- V3b-4: band selector — opens the LBL detail panel for the named bands. -->
		{#if onBandSelect}
			<div class="band-tick-row" role="group" aria-label="Named absorption bands">
				{#each HITRAN_BANDS as band (band.id)}
					<button
						type="button"
						class="band-chip"
						class:active={selectedBandId === band.id}
						aria-pressed={selectedBandId === band.id}
						title={band.description}
						onclick={() => onBandSelect?.(band.id)}>{band.label}</button
					>
				{/each}
			</div>
		{/if}

		<p class="disclaimer">
			Engineering estimate (V0 analytical bake — Rayleigh + Ångström + H₂O bands + O₃). PR-G2 will swap in SMARTS +
			SBDART. Source: <strong>{curve.source}</strong>.
		</p>
		<p class="attrib">
			Inputs: RH via <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> (CC-BY); PWV
			falls back to the default until a point source is wired. Aerosol via
			<a href="https://gibs.earthdata.nasa.gov" target="_blank" rel="noreferrer">NASA GIBS</a> (public domain). Transmission
			model: SMARTS / SBDART analog.
		</p>
	{:else}
		<p class="loading">Waiting for atmospheric inputs…</p>
	{/if}

	<!-- V3b-4: in-sheet detail panel for the user-selected named band. Replaces
	the main chart area when active; "Back" returns to the spectrum. -->
	{#if selectedBandId}
		{@const band = findHitranBand(selectedBandId)}
		<section class="band-detail" aria-label="Band detail">
			<header class="band-detail-header">
				<h4>{band?.label ?? selectedBandId}</h4>
				<button type="button" class="band-back" onclick={() => onBandSelect?.(null)}>Back to spectrum</button>
			</header>
			{#if bandLoading}
				<p class="loading">Loading line-by-line bake…</p>
			{:else if bandError}
				<p class="error">Error: {bandError}</p>
			{:else if bandCurve}
				{@const bandWidth = WIDTH}
				{@const bandHeight = 130}
				{@const bandPad = { left: 36, right: 12, top: 8, bottom: 24 }}
				{@const bandPlotW = bandWidth - bandPad.left - bandPad.right}
				{@const bandPlotH = bandHeight - bandPad.top - bandPad.bottom}
				{@const wl = bandCurve.wavelengthsUm}
				{@const tx = (i: number) => bandPad.left + ((wl[i] - wl[0]) / (wl[wl.length - 1] - wl[0])) * bandPlotW}
				{@const ty = (t: number) => bandPad.top + (1 - t) * bandPlotH}
				<svg
					role="img"
					aria-label="{band?.label ?? 'Band'} line-by-line transmission"
					class="band-chart"
					viewBox="0 0 {bandWidth} {bandHeight}"
				>
					<line
						x1={bandPad.left}
						y1={bandPad.top + bandPlotH}
						x2={bandPad.left + bandPlotW}
						y2={bandPad.top + bandPlotH}
						class="axis"
					></line>
					<line x1={bandPad.left} y1={bandPad.top} x2={bandPad.left} y2={bandPad.top + bandPlotH} class="axis"></line>
					<!-- y grid at T=0, 0.5, 1 -->
					{#each [0, 0.5, 1] as t (t)}
						<line
							x1={bandPad.left}
							x2={bandPad.left + bandPlotW}
							y1={ty(t)}
							y2={ty(t)}
							class="grid"
							stroke-dasharray="2,3"
						></line>
						<text x={bandPad.left - 6} y={ty(t) + 3} class="label-y" text-anchor="end">{t.toFixed(1)}</text>
					{/each}
					<text
						x={bandPad.left + bandPlotW / 2}
						y={bandPad.top + bandPlotH + 18}
						class="axis-title"
						text-anchor="middle">{wl[0].toFixed(3)} – {wl[wl.length - 1].toFixed(3)} µm</text
					>
					<polyline
						points={wl.map((_, i) => `${tx(i).toFixed(1)},${ty(bandCurve.transmission[i]).toFixed(1)}`).join(' ')}
						class="curve"
						fill="none"
					></polyline>
				</svg>
				<p class="attrib">{bandCurve.attribution} · source: <strong>{bandCurve.source}</strong></p>
			{:else}
				<p class="loading">Waiting for line-by-line data…</p>
			{/if}
		</section>
	{/if}
</div>

<style>
	.sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		max-height: min(60vh, 28rem);
		padding: 0.85rem 1.1rem calc(env(safe-area-inset-bottom, 0px) + 0.85rem);
		background: rgba(8, 10, 16, 0.94);
		color: #e9ecf3;
		border-top: 1px solid rgba(255, 255, 255, 0.1);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.78rem;
		overflow-y: auto;
		z-index: 12;
		backdrop-filter: blur(8px);
		animation: slide-up 0.18s ease-out;
	}
	@keyframes slide-up {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.4rem;
	}
	h3 {
		margin: 0;
		font-size: 0.85rem;
	}
	.close {
		background: none;
		border: none;
		color: rgba(233, 236, 243, 0.55);
		cursor: pointer;
		padding: 0.25rem 0.4rem;
	}
	.close:hover {
		color: var(--accent-amber);
	}
	.inputs {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 0.1rem 0.6rem;
		margin: 0.3rem 0 0.6rem;
		font-variant-numeric: tabular-nums;
	}
	.inputs dt {
		opacity: 0.6;
		font-size: 0.66rem;
	}
	.inputs dd {
		margin: 0;
		color: var(--accent-amber);
		font-size: 0.85rem;
	}
	.unit {
		opacity: 0.6;
		font-size: 0.65rem;
		margin-left: 0.15rem;
	}
	.aerosol-picker {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin: 0 0 0.55rem;
	}
	.aerosol-chip {
		font-family: inherit;
		font-size: 0.66rem;
		padding: 0.25rem 0.5rem;
		background: rgba(255, 255, 255, 0.06);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 4px;
		cursor: pointer;
	}
	.aerosol-chip:hover {
		background: rgba(255, 255, 255, 0.12);
	}
	.aerosol-chip.active {
		background: var(--accent-amber);
		color: #0a0e16;
		border-color: var(--accent-amber);
		font-weight: 600;
	}
	.slider-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 0 0.35rem;
	}
	.slider-row label {
		display: grid;
		grid-template-columns: 4.5rem 1fr auto;
		gap: 0.5rem;
		align-items: center;
		width: 100%;
	}
	.slider-label {
		font-size: 0.7rem;
		opacity: 0.75;
	}
	.slider-row input[type='range'] {
		width: 100%;
		accent-color: var(--accent-amber);
	}
	.slider-row input[type='range']:disabled {
		opacity: 0.35;
	}
	.slider-value {
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
		color: var(--accent-amber);
		min-width: 2.5em;
		text-align: right;
	}
	.aod-source {
		margin: 0.15rem 0 0;
		font-size: 0.62rem;
		line-height: 1.3;
		color: rgba(199, 221, 255, 0.78);
		font-style: italic;
	}
	@media (pointer: coarse) {
		.aerosol-chip {
			min-height: 2.5rem;
			padding: 0.4rem 0.6rem;
		}
		.slider-row input[type='range'] {
			min-height: 2.75rem;
		}
	}
	.chart {
		width: 100%;
		max-width: 22rem;
		height: auto;
		display: block;
		margin: 0 auto;
	}
	.axis {
		stroke: rgba(233, 236, 243, 0.45);
		stroke-width: 1;
	}
	.grid {
		stroke: rgba(233, 236, 243, 0.15);
		stroke-width: 1;
	}
	.label-y,
	.label-x {
		fill: rgba(233, 236, 243, 0.6);
		font-size: 9px;
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.axis-title {
		fill: rgba(233, 236, 243, 0.55);
		font-size: 9px;
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.curve {
		stroke: #5ee2d0;
		stroke-width: 1.5;
	}
	.band-tick {
		stroke: rgba(var(--accent-amber-rgb), 0.35);
		stroke-width: 0.5;
		stroke-dasharray: 1.5, 1.5;
	}
	.band-tick-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin: 0.35rem 0 0.4rem;
	}
	.band-chip {
		font-family: inherit;
		font-size: 0.62rem;
		padding: 0.2rem 0.45rem;
		background: rgba(255, 255, 255, 0.05);
		color: rgba(233, 236, 243, 0.85);
		border: 1px solid rgba(var(--accent-amber-rgb), 0.25);
		border-radius: 999px;
		cursor: pointer;
	}
	.band-chip:hover {
		background: rgba(var(--accent-amber-rgb), 0.1);
	}
	.band-chip.active {
		background: var(--accent-amber);
		color: #0a0e16;
		border-color: var(--accent-amber);
	}
	.band-detail {
		margin-top: 0.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid rgba(255, 255, 255, 0.08);
	}
	.band-detail-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.35rem;
	}
	.band-detail-header h4 {
		margin: 0;
		font-size: 0.78rem;
	}
	.band-back {
		background: none;
		border: 1px solid rgba(255, 255, 255, 0.15);
		color: rgba(233, 236, 243, 0.85);
		font: inherit;
		font-size: 0.62rem;
		padding: 0.2rem 0.45rem;
		border-radius: 3px;
		cursor: pointer;
	}
	.band-back:hover {
		color: var(--accent-amber);
		border-color: var(--accent-amber);
	}
	.band-chart {
		width: 100%;
		max-width: 22rem;
		height: auto;
		display: block;
		margin: 0 auto;
	}
	.band-guidance {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin: 0.6rem 0 0.3rem;
		padding: 0.55rem 0.65rem;
		border-radius: 7px;
		background: rgba(97, 220, 163, 0.1);
		border: 1px solid rgba(97, 220, 163, 0.32);
		color: #d6f5e6;
		font-size: 0.73rem;
		line-height: 1.4;
	}
	.band-guidance-takeaway {
		display: flex;
		gap: 0.4rem;
		margin: 0;
		font-weight: 500;
	}
	.band-guidance-icon {
		color: #61dca3;
		font-size: 0.85rem;
		line-height: 1.2;
		flex: 0 0 auto;
	}
	.band-guidance-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.bg-stat {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.64rem;
		padding: 0.12rem 0.4rem;
		border-radius: 4px;
		white-space: nowrap;
	}
	.bg-stat.clear {
		background: rgba(97, 220, 163, 0.18);
		color: #aef0cf;
	}
	.bg-stat.worst {
		background: rgba(255, 130, 120, 0.16);
		color: #ffc7c1;
	}

	/* Laser / EO band quick-select — direct "does my band get through?" answer. */
	.band-presets {
		margin: 0.35rem 0 0.2rem;
	}
	.band-presets-label {
		display: block;
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		opacity: 0.55;
		margin-bottom: 0.3rem;
	}
	.band-presets-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}
	.preset-chip {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.68rem;
		padding: 0.2rem 0.5rem;
		border-radius: 5px;
		border: 1px solid rgba(255, 255, 255, 0.16);
		background: rgba(255, 255, 255, 0.04);
		color: #d4d9e4;
		cursor: pointer;
	}
	.preset-chip:hover {
		background: rgba(255, 255, 255, 0.1);
	}
	.preset-chip.active {
		background: rgba(var(--accent-amber-rgb), 0.18);
		border-color: var(--accent-amber);
		color: var(--accent-amber);
	}
	.preset-readout {
		margin: 0.4rem 0 0;
		font-size: 0.72rem;
		padding: 0.3rem 0.5rem;
		border-radius: 6px;
		border-left: 3px solid rgba(255, 255, 255, 0.25);
		background: rgba(255, 255, 255, 0.04);
	}
	.preset-readout .preset-sub {
		opacity: 0.6;
		font-size: 0.66rem;
	}
	.preset-readout .verdict {
		font-weight: 600;
		text-transform: capitalize;
	}
	.preset-readout.verdict-clear {
		border-left-color: #61dca3;
	}
	.preset-readout.verdict-clear .verdict {
		color: #8fe6bd;
	}
	.preset-readout.verdict-marginal {
		border-left-color: var(--accent-amber);
	}
	.preset-readout.verdict-marginal .verdict {
		color: var(--accent-amber);
	}
	.preset-readout.verdict-blocked,
	.preset-readout.verdict-out-of-range {
		border-left-color: #ff8278;
	}
	.preset-readout.verdict-blocked .verdict {
		color: #ff9c93;
	}
	.derived-tag {
		font-size: 0.56rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		margin-left: 0.3rem;
		padding: 0.05rem 0.28rem;
		border-radius: 4px;
		background: rgba(var(--accent-amber-rgb), 0.16);
		color: var(--accent-amber);
		vertical-align: middle;
		cursor: help;
	}
	.preset-marker {
		stroke: var(--accent-amber);
		stroke-width: 1.5;
		stroke-dasharray: 3 2;
	}
	.param-help {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 0.95rem;
		height: 0.95rem;
		margin-left: 0.2rem;
		border-radius: 999px;
		border: 1px solid rgba(127, 187, 255, 0.45);
		color: #c7ddff;
		font-size: 0.6rem;
		font-weight: 700;
		line-height: 1;
		cursor: pointer;
		vertical-align: middle;
		opacity: 0.8;
	}
	.param-help:hover {
		opacity: 1;
	}
	.disclaimer {
		margin: 0.5rem 0 0.3rem;
		font-size: 0.7rem;
		opacity: 0.75;
		line-height: 1.4;
	}
	.attrib {
		margin: 0;
		font-size: 0.66rem;
		opacity: 0.55;
		line-height: 1.4;
	}
	.attrib a {
		color: var(--accent-amber);
		text-decoration: none;
	}
	.attrib a:hover {
		text-decoration: underline;
	}
	.loading {
		opacity: 0.55;
		font-style: italic;
		margin: 0.5rem 0;
	}
	.error {
		color: #ff6b6b;
		margin: 0.5rem 0;
	}
	@media (min-width: 641px) {
		.sheet {
			left: auto;
			right: 1rem;
			bottom: 4rem;
			max-width: 26rem;
			border-radius: 10px;
			border: 1px solid rgba(255, 255, 255, 0.1);
		}
	}
</style>
