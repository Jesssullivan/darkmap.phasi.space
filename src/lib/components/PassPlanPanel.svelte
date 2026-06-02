<script lang="ts">
	/**
	 * Plan a pass — the Orbit-lens deep tool (S3).
	 *
	 * TLE (via /api/orbit/tle) → SGP4 passes (findPasses) gated by the REAL DEM
	 * horizon for this pin → a master pass-list + a polar az/el track drawn over
	 * the terrain-masked horizon ring. The differentiator: AOS/LOS reflect when
	 * the satellite clears the ridgeline, not the flat 0° math horizon.
	 *
	 * Pick any satellite: a NORAD catalog number, a quick preset, or browse a
	 * Celestrak group (→ a dependent satellite list). The polar track is tinted by
	 * a clear-sky transmittance estimate (airmass → Beer–Lambert) so link quality
	 * along the pass reads at a glance; near-zenith "keyhole" passes (fast rotator
	 * az-slew) are flagged.
	 *
	 * Honesty (the V6 bar): passes are PREDICTED (SGP4); we surface the TLE epoch
	 * age (drift ~1–3 km/day) and Doppler is a prediction. The terrain horizon is
	 * fetched best-effort — if it can't load we fall back to a flat horizon and
	 * say so, never silently. The transmittance tint is a LABELED ESTIMATE
	 * (τ₀≈0.2 clear-sky), not a measurement.
	 */
	import { X } from '@lucide/svelte';
	import { Effect, Layer } from 'effect';
	import HelpTooltip from '$lib/components/HelpTooltip.svelte';
	import { clearSkyTransmittance, findPasses, parseTle, type Pass } from '$lib/orbit';
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
	let horizonFlat = $state(false);
	let horizon = $state<HorizonPolygon | null>(null);

	// ── satellite picker ──────────────────────────────────────────────────────
	interface TleSetView {
		name?: string;
		line1: string;
		line2: string;
		epochAgeDays: number;
	}
	const GROUPS = [
		'amateur',
		'stations',
		'visual',
		'noaa',
		'weather',
		'science',
		'starlink',
		'gps-ops',
		'galileo',
		'cubesat',
	];
	const PRESETS = [
		{ catnr: '25544', label: 'ISS (ZARYA)' },
		{ catnr: '20580', label: 'Hubble (HST)' },
		{ catnr: '48274', label: 'Tiangong (CSS)' },
		{ catnr: '43013', label: 'NOAA-20' },
		{ catnr: '25994', label: 'Terra' },
		{ catnr: '27424', label: 'Aqua' },
	];
	let mode = $state<'catnr' | 'group'>('catnr');
	let group = $state('amateur');
	let catnrField = $state(String(catnr));
	let sets = $state<TleSetView[]>([]);
	let satIndex = $state(0);
	let selectedIndex = $state(0);

	const tleQuery = $derived(
		mode === 'catnr' && /^\d{1,9}$/.test(catnrField.trim()) ? `catnr=${catnrField.trim()}` : `group=${group}`,
	);
	const chosenSet = $derived(sets[satIndex] ?? null);
	const satName = $derived(chosenSet?.name ?? (mode === 'catnr' ? `NORAD ${catnrField.trim()}` : 'satellite'));
	const epochAgeDays = $derived(chosenSet?.epochAgeDays ?? null);

	// Window start fixed at open so the pass list doesn't shift under recompute.
	const windowStart = new Date();

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

	// Terrain horizon — depends only on the site, so a satellite change never
	// re-runs the DEM lookup (best-effort; flat fallback, never silent).
	let horizonGen = 0;
	$effect(() => {
		const loc = { lat: location.lat, lon: location.lon };
		const myGen = ++horizonGen;
		(async () => {
			let poly: HorizonPolygon | null = null;
			try {
				poly = await (await loadHorizon())(loc);
			} catch {
				poly = null;
			}
			if (myGen !== horizonGen) return;
			horizon = poly;
			horizonFlat = poly === null || poly.length === 0;
		})();
	});

	// Elements — re-fetched only when the satellite query changes.
	let tleGen = 0;
	$effect(() => {
		const q = tleQuery;
		const myGen = ++tleGen;
		loading = true;
		errorMsg = null;
		(async () => {
			try {
				const res = await fetch(`/api/orbit/tle?${q}`);
				const data = (await res.json()) as { degraded?: boolean; sets: TleSetView[] };
				if (myGen !== tleGen) return;
				if (data.degraded || !data.sets || data.sets.length === 0) throw new Error('no elements available');
				sets = data.sets;
				if (satIndex > sets.length - 1) satIndex = 0;
				loading = false;
			} catch (e) {
				if (myGen !== tleGen) return;
				errorMsg = e instanceof Error ? e.message : 'failed to load elements';
				sets = [];
				loading = false;
			}
		})();
	});

	// Passes — recompute when the satellite, site, or terrain horizon changes.
	const passes = $derived.by<Pass[]>(() => {
		const set = chosenSet;
		if (!set) return [];
		const { satrec } = parseTle(set.line1, set.line2, set.name);
		return findPasses({
			satrec,
			observer: { latitudeDeg: location.lat, longitudeDeg: location.lon },
			start: windowStart,
			windowHours: 48,
			stepSec: 30,
			horizon: horizon ?? undefined,
			carrierHz,
			maxPasses: 12,
		});
	});
	const selected = $derived(passes[selectedIndex] ?? passes[0] ?? null);

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

	// Map a clear-sky transmittance (≤ ~0.82 at zenith) to a red→amber→green hue.
	const transmittanceColor = (t: number): string => {
		const q = Math.max(0, Math.min(1, t / 0.8187));
		return `hsl(${Math.round(q * 120)}, 80%, 56%)`;
	};
	// Per-pass transmittance at culmination (best elevation) — labeled estimate.
	const passTransmittance = (p: Pass): number => clearSkyTransmittance(p.maxElevationDeg);

	// Pass track coloured by the clear-sky transmittance estimate (airmass → T):
	// green overhead (low airmass) → red near the horizon. A LABELED ESTIMATE.
	const trackSegments = $derived.by(() => {
		if (!selected) return [];
		const t = selected.track;
		const segs: { x1: number; y1: number; x2: number; y2: number; stroke: string }[] = [];
		for (let i = 1; i < t.length; i++) {
			const a = polarXY(t[i - 1].azDeg, t[i - 1].elDeg);
			const b = polarXY(t[i].azDeg, t[i].elDeg);
			const midEl = (t[i - 1].elDeg + t[i].elDeg) / 2;
			segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: transmittanceColor(clearSkyTransmittance(midEl)) });
		}
		return segs;
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

	<div class="pp-picker">
		<label>
			<span class="pp-pick-lbl">Group</span>
			<select
				bind:value={group}
				onchange={() => {
					mode = 'group';
					selectedIndex = 0;
				}}
				aria-label="Satellite group"
			>
				{#each GROUPS as g (g)}<option value={g}>{g}</option>{/each}
			</select>
		</label>
		{#if mode === 'group' && sets.length > 1}
			<label>
				<span class="pp-pick-lbl">Sat</span>
				<select bind:value={satIndex} onchange={() => (selectedIndex = 0)} aria-label="Satellite">
					{#each sets as s, i (s.line2)}<option value={i}>{s.name ?? `set ${i + 1}`}</option>{/each}
				</select>
			</label>
		{/if}
		<label>
			<span class="pp-pick-lbl">NORAD</span>
			<input
				type="text"
				inputmode="numeric"
				class="pp-catnr"
				value={catnrField}
				onchange={(e) => {
					mode = 'catnr';
					catnrField = e.currentTarget.value.trim();
					selectedIndex = 0;
				}}
				placeholder="25544"
				aria-label="NORAD catalog number"
			/>
		</label>
		<select
			class="pp-preset"
			aria-label="Quick presets"
			onchange={(e) => {
				const v = e.currentTarget.value;
				if (v) {
					mode = 'catnr';
					catnrField = v;
					selectedIndex = 0;
				}
				e.currentTarget.value = '';
			}}
		>
			<option value="">Presets…</option>
			{#each PRESETS as p (p.catnr)}<option value={p.catnr}>{p.label}</option>{/each}
		</select>
	</div>

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
				{#each trackSegments as seg, i (i)}
					<line
						class="pp-seg"
						x1={seg.x1}
						y1={seg.y1}
						x2={seg.x2}
						y2={seg.y2}
						stroke={seg.stroke}
						stroke-width="1.8"
						stroke-linecap="round"
					/>
				{/each}
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
							<span class="pp-pass-t" title="Clear-sky transmittance estimate at culmination">
								{(passTransmittance(p) * 100).toFixed(0)}%
							</span>
							<span class="pp-pass-dur">{fmtDur(p.durationSec)}</span>
							{#if p.terrainGated}<span class="pp-gated" title="AOS/LOS raised by terrain">⛰</span>{/if}
							{#if p.keyhole}
								<span
									class="pp-keyhole"
									title="Near-zenith culmination — an az/el rotator must slew azimuth rapidly through zenith">⟲</span
								>
							{/if}
						</button>
					</li>
				{/each}
			</ol>
		</div>

		<div class="pp-legend" aria-hidden="true">
			<span>horizon</span>
			<span class="pp-legend-bar"></span>
			<span>zenith</span>
		</div>

		{#if selected}
			<dl class="pp-detail">
				<dt>AOS</dt>
				<dd>{fmtClock(selected.aos)}Z · {compass(selected.aosAzDeg)}</dd>
				<dt>Max el</dt>
				<dd>{selected.maxElevationDeg.toFixed(1)}° @ {fmtClock(selected.culmination)}Z</dd>
				<dt>LOS</dt>
				<dd>{fmtClock(selected.los)}Z · {compass(selected.losAzDeg)}</dd>
				<dt>
					T at culmination
					<HelpTooltip
						text="Clear-sky atmospheric transmittance estimate at the culmination elevation (airmass → Beer–Lambert, τ₀≈0.2). A LABELED ESTIMATE, not a measurement; the track tints from this — lower (redder) near the horizon."
					>
						{#snippet trigger()}<span class="pp-i">i</span>{/snippet}
					</HelpTooltip>
				</dt>
				<dd>{(passTransmittance(selected) * 100).toFixed(0)}%</dd>
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
				{#if selected.keyhole}
					<dt>Keyhole</dt>
					<dd class="pp-keyhole-note">
						⟲ near-zenith — az slews ~{selected.azSlewPeakDegPerSec.toFixed(0)}°/s through zenith
					</dd>
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
			· track tint = clear-sky T (est.)
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
	.pp-picker {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 0.55rem;
		align-items: center;
		margin-bottom: 0.6rem;
		font-size: 0.68rem;
	}
	.pp-picker label {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.pp-pick-lbl {
		opacity: 0.6;
	}
	.pp-picker select,
	.pp-picker input {
		font: inherit;
		font-size: 0.68rem;
		color: #e9ecf3;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 5px;
		padding: 0.12rem 0.3rem;
	}
	.pp-catnr {
		width: 4.5rem;
	}
	.pp-picker select:focus-visible,
	.pp-picker input:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 1px;
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
	.pp-pass-t {
		font-variant-numeric: tabular-nums;
		opacity: 0.75;
	}
	.pp-pass-dur {
		opacity: 0.6;
	}
	.pp-gated {
		font-size: 0.7rem;
	}
	.pp-keyhole {
		font-size: 0.72rem;
		color: var(--accent-amber);
	}
	.pp-legend {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0.5rem 0 0;
		font-size: 0.58rem;
		opacity: 0.6;
	}
	.pp-legend-bar {
		flex: 1 1 auto;
		height: 4px;
		border-radius: 2px;
		background: linear-gradient(90deg, hsl(0, 80%, 56%), hsl(60, 80%, 56%), hsl(120, 80%, 56%));
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
	.pp-keyhole-note {
		color: var(--accent-amber);
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
