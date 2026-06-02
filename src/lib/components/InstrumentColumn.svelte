<script lang="ts">
	import { onMount } from 'svelte';
	import type { Lens } from '$lib/lens';
	import type { Pm25Station } from '$lib/atmospheric/pm25-diffusion';
	import { buildViewportSummary } from '$lib/atmospheric/viewport-summary';
	import SkyCompass from '$lib/components/SkyCompass.svelte';
	import HelpTooltip from '$lib/components/HelpTooltip.svelte';

	interface Props {
		/** Active persona lens — re-weights which instrument tile leads (Tier-2) vs dims (Tier-3). */
		lens: Lens;
		/** OpenAQ stations currently in the viewport bbox (the smog layer's collection). */
		stations: Pm25Station[];
		/** Viewport-center location for the Sky dome. */
		location: { lat: number; lon: number };
		/** Active ephemeris cursor time. */
		time: Date;
	}

	let { lens, stations, location, time }: Props = $props();

	// Air tile — honest area rollup of the in-view PM2.5 stations (reuses the
	// tested pure helper; null AQI ⇒ no PM2.5 reporting, never a fabricated 0).
	const air = $derived(buildViewportSummary(stations));

	// Re-weight, never gate: each tile is always present. The lens-matched tile is
	// Tier-2 (full); the off-lens tile dims to Tier-3 (still focusable + tooltip-
	// clickable). Mirrors the LayerRail railPrimary mapping — atmosphere leads for
	// air|links, the night-lights/ephemeris families for sky|orbit.
	const airTier = $derived(lens === 'air' || lens === 'links' ? 2 : 3);
	const skyTier = $derived(lens === 'sky' || lens === 'orbit' ? 2 : 3);

	// Gate the embedded SkyCompass behind onMount so its dynamic-import +
	// device-orientation effects fire post-hydration (it swallows failures via
	// console.warn, never error).
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});
</script>

<aside class="instrument-column" aria-label="Lens overview instruments">
	<section class="tile" data-tier={airTier} aria-label="Air — viewport air quality">
		<p class="tile-label">
			Air · viewport
			<HelpTooltip
				text="Max PM2.5 AQI sub-index across the reporting stations currently in view (nowcast-style, not the official daily AQI). The bar + number show the worst category; null when no station reports PM2.5 — never a fabricated 0."
				positioning="right"
			>
				{#snippet trigger()}<span class="tile-info" aria-hidden="true">ⓘ</span>{/snippet}
			</HelpTooltip>
		</p>
		{#if air.aqi}
			<div class="aqi-rule" style:background={air.aqi.maxCategory.color}></div>
			<p class="aqi-value" style:color={air.aqi.maxCategory.color}>{air.aqi.median}</p>
			<p class="aqi-sub">{air.aqi.min}–{air.aqi.max} AQI</p>
			<p class="tile-tally">{air.pm25StationCount}/{air.stationCount} stns</p>
		{:else if air.stationCount > 0}
			<p class="aqi-value empty">—</p>
			<p class="aqi-sub">no PM2.5 · {air.stationCount} stns</p>
		{:else}
			<p class="aqi-value empty">—</p>
			<p class="aqi-sub">no stations in view</p>
		{/if}
	</section>

	<section class="tile sky-tile" data-tier={skyTier} aria-label="Sky — local dome">
		<p class="tile-label">Sky · local dome</p>
		{#if mounted}
			<SkyCompass {location} {time} embedded />
		{/if}
	</section>
</aside>

<style>
	/* Left instrument gutter (PR6). Lives in the 9.5rem --portal-inset-left
	   channel the framed portal opens; off (display:none) until that same
	   desktop @media engages, so mobile/short stays full-bleed with no overlay. */
	.instrument-column {
		/* PR6+7: a flex-row header band INSIDE +page's .left-dock (the re-homed
		   rail sits below). Static, full width — the dock owns positioning + the
		   card chrome. Self-gated to the portal query (belt-and-suspenders with the
		   dock) so it never leaks into the mobile flow under .left-dock{display:contents}. */
		display: none;
		flex-direction: row;
		gap: 0.5rem;
		width: 100%;
		font-family: var(--font-mono, ui-monospace, monospace);
		color: #e9ecf3;
	}
	@media (min-width: 821px) and (min-height: 501px) {
		.instrument-column {
			display: flex;
		}
	}
	.tile {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.12rem;
		padding: 0.4rem 0.3rem;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 6px;
		transition: opacity var(--lens-diff-ms, 200ms) ease;
	}
	/* Off-lens tiles dim to Tier-3 (still present + interactive — never gated). */
	/* PROMOTE, NEVER DIM (UI redesign): the off-lens instrument tile is no longer
	   dimmed — both tiles render at full strength; the active lens leads by order. */
	@media (prefers-reduced-motion: reduce) {
		.tile {
			transition: none;
		}
	}
	.sky-tile {
		padding: 0.4rem 0.35rem;
	}
	.tile-label {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.2rem;
		font-size: 0.58rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		opacity: 0.6;
		margin: 0 0 0.1rem;
		text-align: center;
	}
	.tile-info {
		cursor: help;
		opacity: 0.7;
	}
	.aqi-rule {
		width: 100%;
		height: 3px;
		border-radius: 2px;
	}
	.aqi-value {
		font-size: 1.35rem;
		font-weight: 700;
		line-height: 1.1;
		font-variant-numeric: tabular-nums;
		margin: 0.1rem 0 0;
	}
	.aqi-value.empty {
		color: #e9ecf3;
		opacity: 0.5;
	}
	.aqi-sub {
		font-size: 0.6rem;
		opacity: 0.65;
		font-variant-numeric: tabular-nums;
		margin: 0;
		text-align: center;
	}
	.tile-tally {
		font-size: 0.55rem;
		opacity: 0.5;
		font-variant-numeric: tabular-nums;
		margin: 0;
	}
</style>
