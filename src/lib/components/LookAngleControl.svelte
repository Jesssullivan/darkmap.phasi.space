<script lang="ts">
	/**
	 * LookAngleControl — directable transmission boresight (V3-4).
	 *
	 * The transmission path is no longer assumed straight up: the user aims a
	 * boresight (azimuth + elevation above the horizon) for an RF / laser / EO
	 * link. Four targets:
	 *   - Zenith  — straight up (default; thinnest column).
	 *   - Sun / Moon — snap to the body's current alt-az from the pin ephemeris.
	 *   - Manual  — dial azimuth + elevation directly.
	 *
	 * Parent owns the state and emits via callbacks (same contract as the
	 * aerosol/AOD controls). The polar dial is a live visualization (reusing the
	 * SkyCompass dome projection); the sliders are the accessible input. When the
	 * boresight drops below the local terrain horizon the path is occluded and the
	 * parent suppresses the curve — we surface why here.
	 */
	import type { HorizonPolygon } from '$lib/ephemeris/horizonAtAzimuth';
	import { horizonAtAzimuth } from '$lib/ephemeris/horizonAtAzimuth';
	import { formatAirmass } from '$lib/ephemeris/airmass';
	import type { LookTarget } from '$lib/transmission/look-angle';

	interface Props {
		azimuthDeg: number;
		/** Elevation above the horizon, 0–90 (90 = zenith). */
		elevationDeg: number;
		target: LookTarget;
		/** Derived, display-only. */
		zenithDeg: number;
		/** Derived, display-only; null at/below the horizon. */
		airmass: number | null;
		/** Terrain horizon altitude (deg) at the current azimuth; null when unknown. */
		horizonAltDeg?: number | null;
		/** True when the boresight is below the terrain horizon. */
		occluded?: boolean;
		/** Whether the sun / moon are above the horizon (enables the snap targets). */
		sunAvailable?: boolean;
		moonAvailable?: boolean;
		/** Local terrain horizon polygon, for the dial ring. */
		horizon?: HorizonPolygon | null;
		onTargetChange: (t: LookTarget) => void;
		onAzimuthChange: (v: number) => void;
		onElevationChange: (v: number) => void;
	}

	let {
		azimuthDeg,
		elevationDeg,
		target,
		zenithDeg,
		airmass,
		horizonAltDeg = null,
		occluded = false,
		sunAvailable = false,
		moonAvailable = false,
		horizon = null,
		onTargetChange,
		onAzimuthChange,
		onElevationChange,
	}: Props = $props();

	// Manual dialing is only meaningful for the Manual target; Zenith fixes the
	// angle and Sun/Moon are ephemeris-driven.
	const dialEditable = $derived(target === 'manual');

	// Dome projection (matches SkyCompass): centre 100,100, radius 90 to horizon,
	// below-horizon dots pushed just past the rim.
	const CX = 100;
	const CY = 100;
	const R = 90;
	const polarXY = (az: number, alt: number): { x: number; y: number } => {
		const factor = alt < 0 ? 1.05 : Math.max(0, (90 - alt) / 90);
		const theta = ((az - 90) * Math.PI) / 180;
		return { x: CX + R * factor * Math.cos(theta), y: CY + R * factor * Math.sin(theta) };
	};

	const boresight = $derived(polarXY(azimuthDeg, elevationDeg));
	const horizonPath = $derived.by(() => {
		if (!horizon || horizon.length < 3) return '';
		const pts = horizon.map((s) => polarXY(s.azimuthDeg, Math.max(s.altitudeDeg, -2)));
		return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z';
	});
	// Terrain altitude under the current azimuth, for the dial caption when no
	// explicit horizonAltDeg was supplied.
	const horizonAtBoresight = $derived(
		horizonAltDeg ?? (horizon && horizon.length ? horizonAtAzimuth(horizon, azimuthDeg) : null),
	);

	const TICKS = [
		{ label: 'N', az: 0 },
		{ label: 'E', az: 90 },
		{ label: 'S', az: 180 },
		{ label: 'W', az: 270 },
	];

	const TARGETS: ReadonlyArray<{ id: LookTarget; label: string }> = [
		{ id: 'zenith', label: 'Zenith' },
		{ id: 'sun', label: 'Sun' },
		{ id: 'moon', label: 'Moon' },
		{ id: 'manual', label: 'Manual' },
	];
	const targetDisabled = (id: LookTarget): boolean =>
		(id === 'sun' && !sunAvailable) || (id === 'moon' && !moonAvailable);
</script>

<section class="look-angle" aria-label="Transmission boresight">
	<div class="target-row" role="radiogroup" aria-label="Boresight target">
		{#each TARGETS as t (t.id)}
			<button
				type="button"
				class="look-chip"
				class:active={target === t.id}
				role="radio"
				aria-checked={target === t.id}
				disabled={targetDisabled(t.id)}
				title={targetDisabled(t.id) ? `${t.label} is below the horizon` : `Aim at ${t.label.toLowerCase()}`}
				onclick={() => onTargetChange(t.id)}>{t.label}</button
			>
		{/each}
	</div>

	<div class="dial-and-inputs">
		<svg class="dial" viewBox="0 0 200 200" role="img" aria-label="Boresight azimuth/elevation dome">
			<circle cx={CX} cy={CY} r={R} class="dome" />
			<circle cx={CX} cy={CY} r={R / 2} class="dome-ring" />
			{#if horizonPath}
				<path d={horizonPath} class="horizon" />
			{/if}
			{#each TICKS as tick (tick.az)}
				{@const p = polarXY(tick.az, 0)}
				{@const lp = polarXY(tick.az, -8)}
				<line x1={CX} y1={CY} x2={p.x} y2={p.y} class="tick" />
				<text x={lp.x} y={lp.y} class="tick-label">{tick.label}</text>
			{/each}
			<line x1={CX} y1={CY} x2={boresight.x} y2={boresight.y} class="beam" class:occluded />
			<circle cx={boresight.x} cy={boresight.y} r="5" class="boresight" class:occluded />
		</svg>

		<div class="inputs">
			<label class="slider-row" class:disabled={!dialEditable}>
				<span class="slider-label">Azimuth <span class="val">{Math.round(azimuthDeg)}°</span></span>
				<input
					type="range"
					min="0"
					max="360"
					step="1"
					value={azimuthDeg}
					disabled={!dialEditable}
					aria-label="Boresight azimuth"
					oninput={(e) => onAzimuthChange(Number((e.target as HTMLInputElement).value))}
				/>
			</label>
			<label class="slider-row" class:disabled={!dialEditable}>
				<span class="slider-label">Elevation <span class="val">{Math.round(elevationDeg)}°</span></span>
				<input
					type="range"
					min="0"
					max="90"
					step="1"
					value={elevationDeg}
					disabled={!dialEditable}
					aria-label="Boresight elevation"
					oninput={(e) => onElevationChange(Number((e.target as HTMLInputElement).value))}
				/>
			</label>
			<dl class="derived">
				<div>
					<dt>Zenith</dt>
					<dd>{Math.round(zenithDeg)}°</dd>
				</div>
				<div>
					<dt>Airmass</dt>
					<dd>{formatAirmass(airmass)}</dd>
				</div>
			</dl>
		</div>
	</div>

	{#if occluded}
		<p class="occlusion" role="note">
			Boresight {Math.round(elevationDeg)}° is below the local terrain horizon{horizonAtBoresight !== null
				? ` (${Math.round(horizonAtBoresight)}° ridge)`
				: ''} — no line-of-sight path along this bearing.
		</p>
	{/if}
</section>

<style>
	.look-angle {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 0.6rem;
	}
	.target-row {
		display: flex;
		gap: 0.35rem;
		flex-wrap: wrap;
	}
	.look-chip {
		flex: 1 1 auto;
		padding: 0.3rem 0.5rem;
		font-size: 0.72rem;
		border-radius: 6px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(255, 255, 255, 0.04);
		color: #d7dbe4;
		cursor: pointer;
		transition: background 0.12s ease;
	}
	.look-chip.active {
		background: rgba(var(--accent-amber-rgb), 0.16);
		border-color: rgba(var(--accent-amber-rgb), 0.5);
		color: var(--accent-amber);
	}
	.look-chip:hover:not(:disabled),
	.look-chip:focus-visible {
		background: rgba(var(--accent-amber-rgb), 0.1);
		outline: none;
	}
	.look-chip:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.dial-and-inputs {
		display: flex;
		gap: 0.7rem;
		align-items: center;
	}
	.dial {
		width: 96px;
		height: 96px;
		flex: 0 0 auto;
	}
	.dome {
		fill: rgba(255, 255, 255, 0.03);
		stroke: rgba(255, 255, 255, 0.18);
		stroke-width: 1;
	}
	.dome-ring {
		fill: none;
		stroke: rgba(255, 255, 255, 0.1);
		stroke-width: 0.75;
	}
	.horizon {
		fill: rgba(120, 130, 150, 0.12);
		stroke: rgba(150, 160, 180, 0.5);
		stroke-width: 1;
	}
	.tick {
		stroke: rgba(255, 255, 255, 0.12);
		stroke-width: 0.5;
	}
	.tick-label {
		fill: rgba(233, 236, 243, 0.6);
		font-size: 11px;
		text-anchor: middle;
		dominant-baseline: middle;
	}
	.beam {
		stroke: var(--accent-amber);
		stroke-width: 1.5;
		opacity: 0.8;
	}
	.beam.occluded {
		stroke: #ff6b6b;
	}
	.boresight {
		fill: var(--accent-amber);
		stroke: #0a0c12;
		stroke-width: 1;
	}
	.boresight.occluded {
		fill: #ff6b6b;
	}
	.inputs {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.slider-row {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	.slider-row.disabled {
		opacity: 0.45;
	}
	.slider-label {
		display: flex;
		justify-content: space-between;
		font-size: 0.7rem;
		color: rgba(233, 236, 243, 0.75);
	}
	.slider-label .val {
		color: var(--accent-amber);
		font-variant-numeric: tabular-nums;
	}
	.slider-row input[type='range'] {
		width: 100%;
		accent-color: var(--accent-amber);
	}
	.derived {
		display: flex;
		gap: 1rem;
		margin: 0.1rem 0 0;
	}
	.derived div {
		display: flex;
		gap: 0.3rem;
		align-items: baseline;
	}
	.derived dt {
		font-size: 0.66rem;
		opacity: 0.6;
	}
	.derived dd {
		margin: 0;
		font-size: 0.78rem;
		color: var(--accent-amber);
		font-variant-numeric: tabular-nums;
	}
	.occlusion {
		margin: 0;
		padding: 0.4rem 0.55rem;
		font-size: 0.72rem;
		line-height: 1.3;
		color: #ffb3b3;
		background: rgba(255, 107, 107, 0.1);
		border: 1px solid rgba(255, 107, 107, 0.35);
		border-radius: 6px;
	}
	@media (pointer: coarse) {
		.look-chip {
			min-height: 2.4rem;
		}
		.slider-row input[type='range'] {
			min-height: 1.8rem;
		}
	}
</style>
