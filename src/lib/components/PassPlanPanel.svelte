<script lang="ts">
	/**
	 * Plan a pass — the Orbit-lens deep tool (S3).
	 *
	 * TLE (via /api/orbit/tle) → SGP4 passes (findPasses) gated by the REAL DEM
	 * horizon for this pin → a master pass-list + a polar az/el track drawn over
	 * the terrain-masked horizon ring. The differentiator: AOS/LOS reflect when
	 * the satellite clears the ridgeline, not the flat 0° math horizon.
	 *
	 * Honesty (the V6 bar): passes are PREDICTED (SGP4); we surface the TLE epoch
	 * age (drift ~1–3 km/day) and Doppler is a prediction. The terrain horizon is
	 * fetched best-effort — if it can't load we fall back to a flat horizon and
	 * say so, never silently.
	 */
	import { X } from '@lucide/svelte';
	import { Effect, Layer } from 'effect';
	import HelpTooltip from '$lib/components/HelpTooltip.svelte';
	import { findPasses, parseTle, type Pass } from '$lib/orbit';
	import type { HorizonPolygon } from '$lib/ephemeris/HorizonProvider';

	interface Props {
		/** Ground-station location (the clicked pin / map center). */
		location: { lat: number; lon: number };
		/** Close the docked deep tool. */
		onclose: () => void;
		/** Default NORAD catalog number (ISS). */
		catnr?: number;
		/** Carrier for the Doppler readout, Hz (70 cm amateur downlink default). */
		carrierHz?: number;
	}
	let { location, onclose, catnr = 25544, carrierHz = 437_000_000 }: Props = $props();

	let loading = $state(true);
	let errorMsg = $state<string | null>(null);
	let satName = $state<string>('satellite');
	let epochAgeDays = $state<number | null>(null);
	let horizonFlat = $state(false);
	let passes = $state<Pass[]>([]);
	let selectedIndex = $state(0);
	let horizon = $state<HorizonPolygon | null>(null);

	const selected = $derived(passes[selectedIndex] ?? null);

	// Dynamic-import the Effect terrain stack only when this deep tool opens
	// (mirrors SkyCompass). Returns a Promise-based horizon lookup.
	let horizonClient: Promise<(loc: { lat: number; lon: number }) => Promise<HorizonPolygon>> | null = null;
	const loadHorizon = () => {
		if (!horizonClient) {
			horizonClient = (async () => {
				const [hp, tel] = await Promise.all([
					import('$lib/ephemeris/HorizonProvider'),
					import('$lib/ephemeris/TerrariumElevationLookup'),
				]);
				const layer = hp.HorizonProviderLive.pipe(Layer.provide(tel.TerrariumElevationLookupLive));
				return (loc: { lat: number; lon: number }) =>
					Effect.runPromise(
						Effect.gen(function* () {
							const h = yield* hp.HorizonProvider;
							return yield* h.polygonAt(loc);
						}).pipe(Effect.provide(layer)),
					);
			})();
		}
		return horizonClient;
	};

	let gen = 0;
	$effect(() => {
		const myGen = ++gen;
		const loc = { lat: location.lat, lon: location.lon };
		loading = true;
		errorMsg = null;
		(async () => {
			// 1. Elements.
			let set: { name?: string; line1: string; line2: string; epochAgeDays: number };
			try {
				const res = await fetch(`/api/orbit/tle?catnr=${catnr}`);
				const data = (await res.json()) as {
					degraded?: boolean;
					sets: { name?: string; line1: string; line2: string; epochAgeDays: number }[];
				};
				if (data.degraded || data.sets.length === 0) throw new Error('no elements available');
				set = data.sets[0];
			} catch (e) {
				if (myGen !== gen) return;
				errorMsg = e instanceof Error ? e.message : 'failed to load elements';
				loading = false;
				return;
			}
			if (myGen !== gen) return;
			satName = set.name ?? `NORAD ${catnr}`;
			epochAgeDays = set.epochAgeDays;

			// 2. DEM horizon (best-effort; flat fallback).
			let poly: HorizonPolygon | null = null;
			try {
				poly = await (await loadHorizon())(loc);
			} catch {
				poly = null;
			}
			if (myGen !== gen) return;
			horizon = poly;
			horizonFlat = poly === null || poly.length === 0;

			// 3. Terrain-gated passes over the next 48 h.
			const { satrec } = parseTle(set.line1, set.line2, set.name);
			passes = findPasses({
				satrec,
				observer: { latitudeDeg: loc.lat, longitudeDeg: loc.lon },
				start: new Date(),
				windowHours: 48,
				stepSec: 30,
				horizon: poly ?? undefined,
				carrierHz,
				maxPasses: 12,
			});
			selectedIndex = 0;
			loading = false;
		})();
	});

	// ── polar dome geometry (mirrors SkyCompass) ────────────────────────────
	const CX = 100;
	const CY = 100;
	const R = 90;
	const polarXY = (azimuthDeg: number, altitudeDeg: number) => {
		const factor = altitudeDeg < 0 ? 1.05 : Math.max(0, (90 - altitudeDeg) / 90);
		const theta = ((azimuthDeg - 90) * Math.PI) / 180;
		return { x: CX + R * factor * Math.cos(theta), y: CY + R * factor * Math.sin(theta) };
	};
	const horizonPath = $derived.by(() => {
		if (!horizon || horizon.length < 3) return '';
		return (
			horizon
				.map((s) => polarXY(s.azimuthDeg, Math.max(s.altitudeDeg, -2)))
				.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
				.join(' ') + ' Z'
		);
	});
	const trackPath = $derived.by(() => {
		if (!selected) return '';
		const pts = selected.track.map((s) => polarXY(s.azDeg, s.elDeg));
		return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
	});
	const aosXY = $derived(selected ? polarXY(selected.aosAzDeg, selected.track[0]?.elDeg ?? 0) : null);
	const losXY = $derived(
		selected ? polarXY(selected.losAzDeg, selected.track[selected.track.length - 1]?.elDeg ?? 0) : null,
	);
	const culmXY = $derived.by(() => {
		if (!selected) return null;
		const peak = selected.track.reduce((a, b) => (b.elDeg > a.elDeg ? b : a), selected.track[0]);
		return peak ? polarXY(peak.azDeg, peak.elDeg) : null;
	});
	const culmDopplerHz = $derived.by(() => {
		if (!selected) return null;
		const peak = selected.track.reduce((a, b) => (b.elDeg > a.elDeg ? b : a), selected.track[0]);
		return peak?.dopplerHz ?? null;
	});

	const TICKS = [
		{ label: 'N', az: 0 },
		{ label: 'E', az: 90 },
		{ label: 'S', az: 180 },
		{ label: 'W', az: 270 },
	];
	const fmtClock = (d: Date) =>
		`${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
	const fmtDur = (sec: number) => `${Math.floor(sec / 60)}m${String(Math.round(sec % 60)).padStart(2, '0')}s`;
	const compass = (az: number) =>
		['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8] ?? `${Math.round(az)}°`;
	const epochStale = $derived(epochAgeDays !== null && epochAgeDays > 14);
</script>

<div class="pass-plan" role="dialog" aria-label="Plan a pass">
	<button class="pp-close" type="button" aria-label="Close pass planner" onclick={onclose}>
		<X size={16} aria-hidden="true" />
	</button>
	<header class="pp-head">
		<h4>Plan a pass</h4>
		<span class="pp-sat">{satName}</span>
	</header>

	{#if loading}
		<p class="pp-msg">Propagating passes…</p>
	{:else if errorMsg}
		<p class="pp-msg pp-err">No pass plan: {errorMsg}</p>
	{:else if passes.length === 0}
		<p class="pp-msg">No passes clear the horizon here in the next 48 h.</p>
	{:else}
		<div class="pp-body">
			<svg class="pp-dome" viewBox="0 0 200 200" role="img" aria-label="Polar az/el pass track over the local horizon">
				<circle cx={CX} cy={CY} r={R} fill="rgba(12,16,28,0.6)" stroke="rgba(255,255,255,0.22)" stroke-width="1" />
				<circle cx={CX} cy={CY} r={R * (60 / 90)} fill="none" stroke="rgba(255,255,255,0.08)" />
				<circle cx={CX} cy={CY} r={R * (30 / 90)} fill="none" stroke="rgba(255,255,255,0.08)" />
				<line x1={CX} y1={CY - R} x2={CX} y2={CY + R} stroke="rgba(255,255,255,0.08)" />
				<line x1={CX - R} y1={CY} x2={CX + R} y2={CY} stroke="rgba(255,255,255,0.08)" />
				{#each TICKS as t (t.label)}
					{@const x = CX + (R + 8) * Math.cos(((t.az - 90) * Math.PI) / 180)}
					{@const y = CY + (R + 8) * Math.sin(((t.az - 90) * Math.PI) / 180)}
					<text {x} {y} text-anchor="middle" dominant-baseline="central" class="pp-card">{t.label}</text>
				{/each}
				{#if horizonPath}
					<path d={horizonPath} fill="rgba(110,78,48,0.4)" stroke="rgba(180,130,80,0.75)" stroke-width="0.9" />
				{/if}
				{#if trackPath}
					<path d={trackPath} fill="none" stroke="var(--accent-amber)" stroke-width="1.6" stroke-linejoin="round" />
				{/if}
				{#if aosXY}<circle cx={aosXY.x} cy={aosXY.y} r="2.4" class="pp-aos" />{/if}
				{#if losXY}<circle cx={losXY.x} cy={losXY.y} r="2.4" class="pp-los" />{/if}
				{#if culmXY}<circle cx={culmXY.x} cy={culmXY.y} r="2.8" class="pp-culm" />{/if}
			</svg>

			<ol class="pp-list">
				{#each passes as p, i (p.aos.getTime())}
					<li>
						<button
							type="button"
							class="pp-pass"
							class:active={i === selectedIndex}
							onclick={() => (selectedIndex = i)}
						>
							<span class="pp-pass-time">{fmtClock(p.aos)}Z</span>
							<span class="pp-pass-el">{p.maxElevationDeg.toFixed(0)}° max</span>
							<span class="pp-pass-dur">{fmtDur(p.durationSec)}</span>
							{#if p.terrainGated}<span class="pp-gated" title="AOS/LOS raised by terrain">⛰</span>{/if}
						</button>
					</li>
				{/each}
			</ol>
		</div>

		{#if selected}
			<dl class="pp-detail">
				<dt>AOS</dt>
				<dd>{fmtClock(selected.aos)}Z · {compass(selected.aosAzDeg)}</dd>
				<dt>Max el</dt>
				<dd>{selected.maxElevationDeg.toFixed(1)}° @ {fmtClock(selected.culmination)}Z</dd>
				<dt>LOS</dt>
				<dd>{fmtClock(selected.los)}Z · {compass(selected.losAzDeg)}</dd>
				{#if culmDopplerHz !== null}
					<dt>
						Doppler
						<HelpTooltip
							text="Predicted carrier Doppler at culmination for {(carrierHz / 1e6).toFixed(
								0,
							)} MHz, from the SGP4 range-rate. Re-tune across the pass: +ve approaching, −ve receding."
						>
							{#snippet trigger()}<span class="pp-i">i</span>{/snippet}
						</HelpTooltip>
					</dt>
					<dd>{(culmDopplerHz / 1000).toFixed(1)} kHz</dd>
				{/if}
			</dl>
		{/if}

		<p class="pp-honesty">
			Predicted · SGP4
			{#if epochAgeDays !== null}
				· TLE epoch +{epochAgeDays.toFixed(1)} d{#if epochStale}
					<span class="pp-warn" title="Elements are old; expect cross-track error">⚠ stale</span>{/if}
			{/if}
			{#if horizonFlat}· flat horizon (no terrain){:else}· DEM-gated{/if}
		</p>
	{/if}
</div>

<style>
	/* Self-contained docked deep tool (bottom sheet), mirroring TransmissionSheet
	   so the Orbit lens gets a non-occluding detail panel beside the readout. */
	.pass-plan {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		max-height: min(60vh, 30rem);
		overflow-y: auto;
		padding: 1rem 1.25rem;
		box-sizing: border-box;
		background: rgba(8, 10, 16, 0.94);
		border-top: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 12px 12px 0 0;
		box-shadow: 0 -10px 28px rgba(0, 0, 0, 0.42);
		z-index: 12;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85rem;
		color: #e9ecf3;
		backdrop-filter: blur(8px);
	}
	.pp-close {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		background: none;
		border: none;
		color: rgba(233, 236, 243, 0.55);
		cursor: pointer;
		padding: 0.25rem 0.5rem;
	}
	.pp-close:hover {
		color: var(--accent-amber);
	}
	.pp-close:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 2px;
		color: var(--accent-amber);
	}
	.pp-head {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}
	.pp-head h4 {
		margin: 0;
		font-size: 0.85rem;
		color: var(--accent-amber);
	}
	.pp-sat {
		font-size: 0.7rem;
		opacity: 0.7;
	}
	.pp-msg {
		font-size: 0.75rem;
		opacity: 0.7;
		margin: 0.4rem 0;
	}
	.pp-err {
		color: rgba(255, 138, 138, 0.9);
	}
	.pp-body {
		display: flex;
		gap: 0.75rem;
		align-items: flex-start;
	}
	.pp-dome {
		width: 9.5rem;
		height: 9.5rem;
		flex: 0 0 auto;
	}
	.pp-card {
		font-size: 9px;
		fill: rgba(233, 236, 243, 0.7);
	}
	.pp-aos {
		fill: #66e0a3;
	}
	.pp-los {
		fill: #ff8a8a;
	}
	.pp-culm {
		fill: var(--accent-amber);
	}
	.pp-list {
		list-style: none;
		margin: 0;
		padding: 0;
		flex: 1 1 auto;
		min-width: 0;
		max-height: 9.5rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.pp-pass {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		width: 100%;
		padding: 0.25rem 0.4rem;
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid transparent;
		border-radius: 5px;
		color: #e9ecf3;
		font: inherit;
		font-size: 0.7rem;
		cursor: pointer;
		text-align: left;
	}
	.pp-pass:hover {
		background: rgba(255, 255, 255, 0.08);
	}
	.pp-pass.active {
		border-color: rgba(var(--accent-amber-rgb), 0.6);
		background: rgba(var(--accent-amber-rgb), 0.12);
	}
	.pp-pass:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 1px;
	}
	.pp-pass-time {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
	.pp-pass-el {
		flex: 1 1 auto;
		opacity: 0.8;
	}
	.pp-pass-dur {
		opacity: 0.6;
	}
	.pp-gated {
		font-size: 0.7rem;
	}
	.pp-detail {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.1rem 0.6rem;
		margin: 0.6rem 0 0;
		font-size: 0.72rem;
	}
	.pp-detail dt {
		opacity: 0.6;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.pp-detail dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
	}
	.pp-i,
	.pp-warn {
		font-size: 0.58rem;
		border: 1px solid rgba(255, 255, 255, 0.25);
		border-radius: 999px;
		padding: 0 0.3rem;
		opacity: 0.7;
		cursor: help;
	}
	.pp-warn {
		color: var(--accent-amber);
		border-color: rgba(var(--accent-amber-rgb), 0.5);
	}
	.pp-honesty {
		margin: 0.6rem 0 0;
		font-size: 0.62rem;
		opacity: 0.6;
	}
</style>
