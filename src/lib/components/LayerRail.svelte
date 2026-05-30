<script lang="ts">
	import { ChevronDown, ChevronRight, Info, Menu, X } from '@lucide/svelte';
	import { BASEMAPS } from '$lib/basemaps';
	import { rampFor, VIIRS_RAMP } from '$lib/color-ramps';
	import { VIIRS_YEARS, type RasterLayerDef } from '$lib/layers';
	import { layerHealth } from '$lib/layers/HealthRegistry.svelte';
	import { healthLabel, healthTone } from '$lib/layers/health-state';
	import { modelCardFor } from '$lib/atmospheric/model-cards';
	import HelpTooltip from '$lib/components/HelpTooltip.svelte';
	import Legend from './Legend.svelte';

	export interface LayerState {
		on: boolean;
		opacity: number;
	}

	interface Props {
		layers: ReadonlyArray<RasterLayerDef>;
		states: Record<string, LayerState>;
		onchange: (id: string, partial: Partial<LayerState>) => void;
		basemap: string;
		onbasemapchange: (id: string) => void;
		/**
		 * Current ephemeris / forecast time. Drives the atmospheric "stale"
		 * badge — atmospheric layers fetch near-real-time imagery and forecast
		 * point data, so scrubbing too far from now flags those rows.
		 */
		time?: Date;
		/** Called when the user hits the `(i)` chevron on an atmospheric row — opens the transmission sheet (PR-H). */
		oninfo?: (layerId: string) => void;
	}

	let { layers, states, onchange, basemap, onbasemapchange, time, oninfo }: Props = $props();

	let drawerOpen = $state(false);
	const close = () => (drawerOpen = false);

	// Category partition. VIIRS Annual is its own picker (below); the styled
	// World Atlas sits in the Light Pollution section; atmospheric layers get
	// their own collapsible group. (The unstyled WA_2015_raw grid is not a
	// public overlay — it backs the point-query readout only.)
	const lightExtras = $derived(layers.filter((l) => l.group === 'world_atlas'));
	const atmosphericLayers = $derived(layers.filter((l) => l.group === 'atmospheric'));

	let lightOpen = $state(true);
	let atmosphereOpen = $state(false);

	// 36 h crossover for the atmospheric stale badge. GIBS NRT is past-only
	// (T+3 h SLA); Open-Meteo forecasts ~16 days forward. A user scrubbing
	// more than a day and a half from "now" is likely outside the fetch
	// window for at least one of the active overlays — flag the section so
	// the absence of fresh tiles isn't read as a missing-data bug.
	const ATMOSPHERIC_STALE_MS = 36 * 3_600_000;
	const atmosphericStale = $derived.by(() => {
		if (!time) return false;
		return Math.abs(time.getTime() - Date.now()) > ATMOSPHERIC_STALE_MS;
	});

	// Active VIIRS year (single-select within the group). Falls back to the
	// newest year if nothing's on, or the first .on entry otherwise.
	const activeViirsId = $derived.by(() => {
		const onEntry = VIIRS_YEARS.find((l) => states[l.id]?.on);
		return onEntry?.id ?? VIIRS_YEARS[0]?.id;
	});
	const viirsOn = $derived(VIIRS_YEARS.some((l) => states[l.id]?.on));
	const viirsOpacity = $derived(states[activeViirsId ?? '']?.opacity ?? VIIRS_YEARS[0]?.opacity ?? 0.85);

	/** Switch which VIIRS year is rendered: turn off all others, turn on the picked one. */
	function pickViirsYear(id: string): void {
		for (const l of VIIRS_YEARS) {
			if (l.id !== id && states[l.id]?.on) onchange(l.id, { on: false });
		}
		onchange(id, { on: true, opacity: viirsOpacity });
	}

	function toggleViirs(on: boolean): void {
		if (on) {
			onchange(activeViirsId ?? VIIRS_YEARS[0].id, { on: true, opacity: viirsOpacity });
		} else {
			for (const l of VIIRS_YEARS) {
				if (states[l.id]?.on) onchange(l.id, { on: false });
			}
		}
	}

	function setViirsOpacity(opacity: number): void {
		// Push the opacity to every VIIRS year so toggling years preserves
		// the slider position.
		for (const l of VIIRS_YEARS) onchange(l.id, { opacity });
	}
</script>

<button
	class="rail-toggle"
	aria-label={drawerOpen ? 'Close layers' : 'Open layers'}
	aria-expanded={drawerOpen}
	onclick={() => (drawerOpen = !drawerOpen)}
>
	{#if drawerOpen}
		<X size={16} aria-hidden="true" />
	{:else}
		<Menu size={16} aria-hidden="true" />
	{/if}
	<span class="rail-toggle-label">Layers</span>
</button>

{#if drawerOpen}
	<div class="rail-backdrop" role="presentation" onclick={close} onkeydown={(e) => e.key === 'Escape' && close()}></div>
{/if}

{#snippet modelInfo(id: string)}
	{@const card = modelCardFor(id)}
	{#if card}
		<HelpTooltip positioning="right">
			{#snippet trigger()}
				<span class="model-help" role="img" aria-label="About {card.title}">?</span>
			{/snippet}
			{#snippet content()}
				<div class="model-card">
					<p class="model-card-head"><strong>{card.title}</strong><span class="model-kind">{card.kind}</span></p>
					<p>{card.what}</p>
					{#if card.units}<p class="model-units">Units: {card.units}</p>{/if}
					<p class="model-src"><a href={card.href} target="_blank" rel="noopener">{card.source} ↗</a></p>
				</div>
			{/snippet}
		</HelpTooltip>
	{/if}
{/snippet}

<aside class="layer-rail" class:open={drawerOpen} aria-label="Map layers">
	<header>
		<h2>Layers</h2>
		<p>VIIRS · World Atlas · Atmosphere</p>
	</header>

	<section class="basemap-section" aria-label="Basemap">
		<p class="section-title">
			<span>Basemap</span>
			{#if basemap}
				{@const h = layerHealth.getHealth(basemap)}
				{#if h.tag !== 'idle'}
					<span class="health-pill health-{healthTone(h)}" title={h.reason ?? healthLabel(h)}>{healthLabel(h)}</span>
				{/if}
			{/if}
		</p>
		<div class="basemap-row" role="radiogroup" aria-label="Basemap">
			{#each BASEMAPS as bm (bm.id)}
				<button
					type="button"
					class="basemap-chip"
					class:active={basemap === bm.id}
					aria-pressed={basemap === bm.id}
					title={bm.description}
					onclick={() => onbasemapchange(bm.id)}
				>
					{bm.label}
				</button>
			{/each}
		</div>
	</section>

	<section class="category" aria-label="Light Pollution">
		<button type="button" class="category-header" aria-expanded={lightOpen} onclick={() => (lightOpen = !lightOpen)}>
			{#if lightOpen}
				<ChevronDown size={14} aria-hidden="true" />
			{:else}
				<ChevronRight size={14} aria-hidden="true" />
			{/if}
			<span>Light Pollution</span>
		</button>

		{#if lightOpen}
			<ul>
				<!-- VIIRS Annual: single toggle + year picker + shared opacity. -->
				<li>
					<label class="layer-toggle">
						<input
							type="checkbox"
							checked={viirsOn}
							onchange={(e) => toggleViirs((e.target as HTMLInputElement).checked)}
						/>
						<span class="label">VIIRS Annual</span>
						{#if viirsOn && activeViirsId}
							{@const h = layerHealth.getHealth(activeViirsId)}
							{#if h.tag !== 'idle' && h.tag !== 'rendered'}
								<span class="health-pill health-{healthTone(h)}" title={h.reason ?? healthLabel(h)}>
									{healthLabel(h)}
								</span>
							{/if}
						{/if}
					</label>
					<div class="year-row" role="radiogroup" aria-label="VIIRS year">
						{#each VIIRS_YEARS as l (l.id)}
							<button
								type="button"
								class="year-chip"
								class:active={activeViirsId === l.id}
								aria-pressed={activeViirsId === l.id}
								disabled={!viirsOn}
								onclick={() => pickViirsYear(l.id)}
							>
								{l.year}
							</button>
						{/each}
					</div>
					{#if viirsOn}
						<div class="opacity-row">
							<input
								type="range"
								min="0"
								max="1"
								step="0.05"
								value={viirsOpacity}
								aria-label="VIIRS opacity"
								oninput={(e) => setViirsOpacity(Number((e.target as HTMLInputElement).value))}
							/>
							<span class="opacity-pct" aria-hidden="true">{Math.round(viirsOpacity * 100)}%</span>
						</div>
					{/if}
					<p class="desc">NOAA VIIRS DNB annual composites, 2012–2019. {@render modelInfo('viirs_annual')}</p>
					{#if viirsOn}
						<Legend ramp={VIIRS_RAMP} title="VIIRS color scale" />
					{/if}
				</li>

				<!-- World Atlas (styled): one toggle + opacity. -->
				{#each lightExtras as layer (layer.id)}
					{@const ls = states[layer.id] ?? { on: false, opacity: layer.opacity }}
					<li>
						<label class="layer-toggle">
							<input
								type="checkbox"
								checked={ls.on}
								onchange={(e) => onchange(layer.id, { on: (e.target as HTMLInputElement).checked })}
							/>
							<span class="label">{layer.label}</span>
							{#if ls.on}
								{@const h = layerHealth.getHealth(layer.id)}
								{#if h.tag !== 'idle' && h.tag !== 'rendered'}
									<span class="health-pill health-{healthTone(h)}" title={h.reason ?? healthLabel(h)}>
										{healthLabel(h)}
									</span>
								{/if}
							{/if}
						</label>
						{#if ls.on}
							<div class="opacity-row">
								<input
									type="range"
									min="0"
									max="1"
									step="0.05"
									value={ls.opacity}
									aria-label="{layer.label} opacity"
									oninput={(e) => onchange(layer.id, { opacity: Number((e.target as HTMLInputElement).value) })}
								/>
								<span class="opacity-pct" aria-hidden="true">{Math.round(ls.opacity * 100)}%</span>
							</div>
						{/if}
						<p class="desc">{layer.description} {@render modelInfo(layer.id)}</p>
						{#if ls.on && layer.upstreamLayer}
							{@const ramp = rampFor(layer.upstreamLayer)}
							{#if ramp}
								<Legend {ramp} title="{layer.label} scale" />
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if atmosphericLayers.length > 0}
		<section class="category" aria-label="Atmosphere">
			<button
				type="button"
				class="category-header"
				aria-expanded={atmosphereOpen}
				onclick={() => (atmosphereOpen = !atmosphereOpen)}
			>
				{#if atmosphereOpen}
					<ChevronDown size={14} aria-hidden="true" />
				{:else}
					<ChevronRight size={14} aria-hidden="true" />
				{/if}
				<span>Atmosphere</span>
				{#if atmosphericStale}
					<span class="stale-pill" title="Time is outside the typical fetch window">outside fetch window</span>
				{/if}
			</button>

			{#if atmosphereOpen}
				<ul>
					{#each atmosphericLayers as layer (layer.id)}
						{@const ls = states[layer.id] ?? { on: false, opacity: layer.opacity }}
						<li class:stale={atmosphericStale && ls.on}>
							<div class="atmospheric-row-head">
								<label class="layer-toggle">
									<input
										type="checkbox"
										checked={ls.on}
										onchange={(e) => onchange(layer.id, { on: (e.target as HTMLInputElement).checked })}
									/>
									<span class="label">{layer.label}</span>
									{#if ls.on}
										{@const h = layerHealth.getHealth(layer.id)}
										{#if h.tag !== 'idle' && h.tag !== 'rendered'}
											<span class="health-pill health-{healthTone(h)}" title={h.reason ?? healthLabel(h)}>
												{healthLabel(h)}
											</span>
										{/if}
									{/if}
								</label>
								{#if oninfo}
									<button
										type="button"
										class="info-btn"
										aria-label="{layer.label} — open transmission sheet"
										onclick={() => oninfo?.(layer.id)}
									>
										<Info size={14} aria-hidden="true" />
									</button>
								{/if}
							</div>
							{#if ls.on}
								<div class="opacity-row">
									<input
										type="range"
										min="0"
										max="1"
										step="0.05"
										value={ls.opacity}
										aria-label="{layer.label} opacity"
										oninput={(e) => onchange(layer.id, { opacity: Number((e.target as HTMLInputElement).value) })}
									/>
									<span class="opacity-pct" aria-hidden="true">{Math.round(ls.opacity * 100)}%</span>
								</div>
							{/if}
							<p class="desc">{layer.description} {@render modelInfo(layer.id)}</p>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</aside>

<style>
	.rail-toggle {
		position: fixed;
		top: 4.25rem;
		left: 1rem;
		z-index: 12;
		background: rgba(8, 10, 16, 0.85);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 6px;
		padding: 0.45rem 0.7rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85rem;
		cursor: pointer;
		backdrop-filter: blur(6px);
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}
	.rail-toggle:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 2px;
	}
	.rail-toggle-label {
		display: none;
	}

	.rail-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.35);
		z-index: 9;
		animation: fade-in 0.15s ease-out;
	}

	.layer-rail {
		position: fixed;
		top: 7rem;
		left: 1rem;
		max-width: 19rem;
		max-height: calc(100vh - 9rem);
		overflow-y: auto;
		padding: 1rem 1.25rem;
		background: rgba(8, 10, 16, 0.85);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 8px;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85rem;
		z-index: 10;
		backdrop-filter: blur(6px);
		animation: fade-in 0.2s ease-out;
	}

	@keyframes fade-in {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	header h2 {
		margin: 0 0 0.25rem 0;
		font-size: 1rem;
		letter-spacing: 0.02em;
	}
	header p {
		margin: 0 0 0.75rem 0;
		opacity: 0.55;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.basemap-section {
		margin-bottom: 1rem;
		padding-bottom: 0.85rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	}
	.section-title {
		margin: 0 0 0.4rem 0;
		font-size: 0.7rem;
		opacity: 0.55;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		/* Allow the inline health pill to float right of the label. */
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.4rem;
	}
	.section-title > span {
		flex: 0 0 auto;
	}
	.section-title .health-pill {
		text-transform: none;
		letter-spacing: 0;
	}
	.basemap-row {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.25rem;
	}
	.basemap-chip {
		font-family: inherit;
		font-size: 0.72rem;
		padding: 0.3rem 0;
		background: rgba(255, 255, 255, 0.05);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 4px;
		cursor: pointer;
		transition:
			background 0.12s,
			border-color 0.12s;
	}
	.basemap-chip:hover:not(.active) {
		background: rgba(255, 255, 255, 0.1);
	}
	.basemap-chip.active {
		background: var(--accent-amber);
		color: #0a0e16;
		border-color: var(--accent-amber);
		font-weight: 600;
	}
	.basemap-chip:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 1px;
	}

	.category {
		margin-top: 0.85rem;
	}
	.category + .category {
		margin-top: 1rem;
		padding-top: 0.85rem;
		border-top: 1px solid rgba(255, 255, 255, 0.08);
	}
	.category-header {
		display: inline-flex;
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
	.category-header:hover {
		color: var(--accent-amber);
	}
	.category-header:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 2px;
	}
	.atmospheric-row-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.atmospheric-row-head .layer-toggle {
		flex: 1 1 auto;
	}
	.info-btn {
		flex: 0 0 auto;
		background: none;
		border: none;
		color: rgba(233, 236, 243, 0.55);
		cursor: pointer;
		padding: 0.25rem 0.4rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.info-btn:hover,
	.info-btn:focus-visible {
		color: var(--accent-amber);
		outline: none;
	}
	@media (pointer: coarse) {
		.info-btn {
			min-width: 2.5rem;
			min-height: 2.5rem;
		}
	}
	.health-pill {
		margin-left: 0.4rem;
		padding: 0.05rem 0.35rem;
		font-size: 0.6rem;
		border-radius: 999px;
		border: 1px solid transparent;
		text-transform: lowercase;
		letter-spacing: 0.02em;
		font-variant-numeric: tabular-nums;
	}
	.health-pill.health-neutral {
		background: rgba(255, 255, 255, 0.06);
		color: rgba(233, 236, 243, 0.65);
		border-color: rgba(255, 255, 255, 0.12);
	}
	.health-pill.health-good {
		background: rgba(94, 226, 208, 0.12);
		color: #5ee2d0;
		border-color: rgba(94, 226, 208, 0.35);
	}
	.health-pill.health-warn {
		background: rgba(var(--accent-amber-rgb), 0.12);
		color: var(--accent-amber);
		border-color: rgba(var(--accent-amber-rgb), 0.35);
	}
	.health-pill.health-bad {
		background: rgba(255, 107, 107, 0.15);
		color: #ff6b6b;
		border-color: rgba(255, 107, 107, 0.45);
	}
	.stale-pill {
		margin-left: auto;
		text-transform: none;
		letter-spacing: 0;
		font-size: 0.62rem;
		padding: 0.1rem 0.4rem;
		border-radius: 999px;
		background: rgba(var(--accent-amber-rgb), 0.15);
		color: var(--accent-amber);
		border: 1px solid rgba(var(--accent-amber-rgb), 0.35);
	}

	ul {
		list-style: none;
		padding: 0;
		margin: 0.5rem 0 0;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}
	li.stale {
		opacity: 0.65;
	}
	.layer-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}
	.label {
		font-weight: 500;
	}

	.year-row {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.25rem;
		margin: 0.4rem 0 0 1.5rem;
	}
	.year-chip {
		font-family: inherit;
		font-size: 0.7rem;
		padding: 0.25rem 0;
		background: rgba(255, 255, 255, 0.05);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 4px;
		cursor: pointer;
		transition:
			background 0.12s,
			border-color 0.12s;
	}
	.year-chip:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.1);
	}
	.year-chip.active {
		background: var(--accent-amber);
		color: #0a0e16;
		border-color: var(--accent-amber);
		font-weight: 600;
	}
	.year-chip:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.year-chip:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 1px;
	}

	.opacity-row {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.5rem;
		align-items: center;
		margin-top: 0.4rem;
		padding-left: 1.5rem;
	}
	.opacity-row input[type='range'] {
		width: 100%;
		accent-color: var(--accent-amber);
		min-height: 1.25rem;
	}
	.opacity-pct {
		font-variant-numeric: tabular-nums;
		font-size: 0.7rem;
		opacity: 0.65;
		min-width: 2.6em;
		text-align: right;
	}
	.desc {
		margin: 0.25rem 0 0 1.5rem;
		opacity: 0.6;
		font-size: 0.72rem;
		line-height: 1.35;
	}
	/* Inline "?" model-card affordance — opens a Popover explaining the layer. */
	.model-help {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.05rem;
		height: 1.05rem;
		border-radius: 999px;
		border: 1px solid rgba(127, 187, 255, 0.45);
		color: #c7ddff;
		font-size: 0.66rem;
		font-weight: 700;
		line-height: 1;
		vertical-align: baseline;
		cursor: pointer;
		opacity: 0.85;
	}
	.model-help:hover {
		opacity: 1;
		background: rgba(127, 187, 255, 0.14);
	}
	:global(.model-card) {
		max-width: 17rem;
		font-size: 0.72rem;
		line-height: 1.4;
	}
	:global(.model-card p) {
		margin: 0 0 0.3rem 0;
	}
	:global(.model-card-head) {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}
	:global(.model-kind) {
		font-size: 0.58rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		opacity: 0.7;
	}
	:global(.model-units) {
		opacity: 0.7;
		font-variant-numeric: tabular-nums;
	}
	:global(.model-src a) {
		color: var(--accent-amber);
	}
	input[type='checkbox'] {
		accent-color: var(--accent-amber);
	}

	@media (pointer: coarse) {
		.opacity-row input[type='range'] {
			min-height: 2.75rem;
		}
	}

	@media (max-width: 640px) {
		.rail-toggle-label {
			display: inline;
		}
		.layer-rail {
			top: 0;
			left: 0;
			max-width: 100vw;
			width: 88vw;
			max-height: calc(100dvh - env(safe-area-inset-bottom, 0px));
			height: calc(100dvh - env(safe-area-inset-bottom, 0px));
			border-radius: 0;
			border-right: 1px solid rgba(255, 255, 255, 0.08);
			border-top: 0;
			border-bottom: 0;
			border-left: 0;
			padding-top: 4rem;
			padding-bottom: calc(var(--field-bottom-reserve, 7.75rem) + 1rem);
			transform: translateX(-100%);
			transition: transform 0.2s ease-out;
			animation: none;
		}
		.layer-rail.open {
			transform: translateX(0);
		}
	}

	@media (min-width: 641px) {
		.rail-toggle {
			display: none;
		}
		.rail-backdrop {
			display: none;
		}
	}
</style>
