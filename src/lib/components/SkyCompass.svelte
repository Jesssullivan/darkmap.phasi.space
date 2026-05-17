<script lang="ts">
	import { Effect } from 'effect';
	import { onDestroy } from 'svelte';
	import type { BodyPosition, EphemerisReadout, LatLon, SkyPositions } from '$lib/ephemeris/EphemerisClient';

	interface Props {
		location: LatLon;
		time: Date;
	}

	let { location, time }: Props = $props();

	let readout = $state<EphemerisReadout | null>(null);
	let trajectory = $state<{ frac: number; sun: BodyPosition }[]>([]);

	type PositionFn = (loc: LatLon, t: Date) => Promise<SkyPositions>;
	type AtFn = (loc: LatLon, t: Date) => Promise<EphemerisReadout>;
	let clientPromise: Promise<{ positionAt: PositionFn; at: AtFn }> | null = null;
	const loadClient = (): Promise<{ positionAt: PositionFn; at: AtFn }> => {
		if (!clientPromise) {
			clientPromise = (async () => {
				const mod = await import('$lib/ephemeris/EphemerisClient');
				return {
					positionAt: (loc, t) =>
						Effect.runPromise(
							Effect.gen(function* () {
								const c = yield* mod.EphemerisClient;
								return yield* c.positionAt(loc, t);
							}).pipe(Effect.provide(mod.EphemerisClientLive)),
						),
					at: (loc, t) =>
						Effect.runPromise(
							Effect.gen(function* () {
								const c = yield* mod.EphemerisClient;
								return yield* c.at(loc, t);
							}).pipe(Effect.provide(mod.EphemerisClientLive)),
						),
				};
			})();
		}
		return clientPromise;
	};

	let cancelGen = 0;
	const dayKey = $derived(
		`${time.getUTCFullYear()}-${time.getUTCMonth()}-${time.getUTCDate()}|${location.lat.toFixed(3)},${location.lon.toFixed(3)}`,
	);

	$effect(() => {
		const myGen = ++cancelGen;
		(async () => {
			const c = await loadClient();
			const r = await c.at(location, time);
			if (myGen !== cancelGen) return;
			readout = r;
			// Sample sun position every 15 min from astro dawn to astro dusk so
			// the trajectory shows the full visible-light cycle. Fall back to
			// the whole UTC day when polar (no twilight events).
			const dayStart = Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate());
			const start = r.events.astronomicalDawn ?? new Date(dayStart);
			const end = r.events.astronomicalDusk ?? new Date(dayStart + 24 * 3600 * 1000);
			const span = end.getTime() - start.getTime();
			if (span <= 0) {
				trajectory = [];
				return;
			}
			const samples: { frac: number; sun: BodyPosition }[] = [];
			const STEP_MS = 15 * 60 * 1000;
			for (let ts = start.getTime(); ts <= end.getTime(); ts += STEP_MS) {
				const p = await c.positionAt(location, new Date(ts));
				if (myGen !== cancelGen) return;
				samples.push({ frac: (ts - start.getTime()) / span, sun: p.sun });
			}
			trajectory = samples;
		})().catch((e) => {
			if (myGen === cancelGen) console.warn('SkyCompass: failed to load', e);
		});
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		dayKey;
	});

	$effect(() => {
		const myGen = ++cancelGen;
		(async () => {
			const c = await loadClient();
			const p = await c.positionAt(location, time);
			if (myGen !== cancelGen) return;
			cursor = p;
		})().catch(() => undefined);
		// re-run on time change only — location triggers the heavier effect above
		time;
	});

	let cursor = $state<SkyPositions | null>(null);

	onDestroy(() => {
		cancelGen++;
	});

	// Compass geometry. SVG viewBox is 0..200; origin at center (100,100),
	// radius 90 from center to horizon. Below-horizon dots sit at radius 95
	// in a dimmed style.
	const CX = 100;
	const CY = 100;
	const R = 90;

	const polarXY = (azimuth: number, altitude: number): { x: number; y: number; below: boolean } => {
		const below = altitude < 0;
		const factor = below ? 1.05 : Math.max(0, (90 - altitude) / 90);
		const theta = ((azimuth - 90) * Math.PI) / 180;
		return {
			x: CX + R * factor * Math.cos(theta),
			y: CY + R * factor * Math.sin(theta),
			below,
		};
	};

	const trajectoryPath = $derived.by(() => {
		if (trajectory.length < 2) return '';
		// Skip below-horizon points to keep the arc clean.
		const visible = trajectory.filter((s) => s.sun.altitudeDeg >= 0);
		if (visible.length < 2) return '';
		const pts = visible.map((s) => polarXY(s.sun.azimuthDeg, s.sun.altitudeDeg));
		return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
	});

	const sunPos = $derived(cursor ? polarXY(cursor.sun.azimuthDeg, cursor.sun.altitudeDeg) : null);
	const moonPos = $derived(cursor ? polarXY(cursor.moon.azimuthDeg, cursor.moon.altitudeDeg) : null);

	// Cardinal tick positions on the rim (clockwise from N at top).
	const TICKS = [
		{ label: 'N', az: 0 },
		{ label: 'E', az: 90 },
		{ label: 'S', az: 180 },
		{ label: 'W', az: 270 },
	];

	const fmtAlt = (a: number | undefined): string => (a === undefined ? '—' : `${a.toFixed(1)}°`);
	const fmtAz = (a: number | undefined): string => (a === undefined ? '—' : `${a.toFixed(0)}°`);
</script>

<div class="sky" aria-label="Sky compass at viewport center">
	<svg viewBox="0 0 200 200" role="img" aria-label="Sun and moon positions on local sky dome">
		<defs>
			<radialGradient id="sky-bg" cx="50%" cy="50%" r="50%">
				<stop offset="0%" stop-color="rgba(127, 187, 255, 0.18)" />
				<stop offset="80%" stop-color="rgba(31, 58, 115, 0.18)" />
				<stop offset="100%" stop-color="rgba(6, 8, 13, 0.35)" />
			</radialGradient>
		</defs>
		<circle cx={CX} cy={CY} r={R} fill="url(#sky-bg)" stroke="rgba(255,255,255,0.25)" stroke-width="1" />
		<!-- altitude rings at 30 and 60 -->
		<circle cx={CX} cy={CY} r={R * (60 / 90)} fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
		<circle cx={CX} cy={CY} r={R * (30 / 90)} fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
		<!-- cardinal cross -->
		<line x1={CX} y1={CY - R} x2={CX} y2={CY + R} stroke="rgba(255,255,255,0.08)" />
		<line x1={CX - R} y1={CY} x2={CX + R} y2={CY} stroke="rgba(255,255,255,0.08)" />
		{#each TICKS as t (t.label)}
			{@const x = CX + (R + 8) * Math.cos(((t.az - 90) * Math.PI) / 180)}
			{@const y = CY + (R + 8) * Math.sin(((t.az - 90) * Math.PI) / 180)}
			<text {x} {y} text-anchor="middle" dominant-baseline="central" class="cardinal">{t.label}</text>
		{/each}

		{#if trajectoryPath}
			<path
				d={trajectoryPath}
				fill="none"
				stroke="rgba(255, 209, 102, 0.55)"
				stroke-width="1.5"
				stroke-dasharray="2 2"
			/>
		{/if}

		{#if moonPos}
			<circle
				cx={moonPos.x}
				cy={moonPos.y}
				r={moonPos.below ? 2.5 : 4}
				fill={moonPos.below ? 'rgba(220,220,255,0.35)' : '#dde2ff'}
				stroke="rgba(255,255,255,0.5)"
			/>
		{/if}
		{#if sunPos}
			<circle
				cx={sunPos.x}
				cy={sunPos.y}
				r={sunPos.below ? 3 : 5}
				fill={sunPos.below ? 'rgba(255,209,102,0.35)' : '#ffd166'}
				stroke="rgba(255,255,255,0.6)"
			/>
		{/if}
	</svg>
	<div class="readout">
		<div class="row">
			<span class="badge sun">☼</span>
			<span>alt {fmtAlt(cursor?.sun.altitudeDeg)}</span>
			<span>az {fmtAz(cursor?.sun.azimuthDeg)}</span>
		</div>
		<div class="row">
			<span class="badge moon">☾</span>
			<span>alt {fmtAlt(cursor?.moon.altitudeDeg)}</span>
			<span>az {fmtAz(cursor?.moon.azimuthDeg)}</span>
			{#if readout}
				<span class="phase">{readout.moon.phaseName}</span>
			{/if}
		</div>
	</div>
</div>

<style>
	.sky {
		position: fixed;
		top: 1rem;
		right: 1rem;
		width: 9.5rem;
		background: rgba(8, 10, 16, 0.78);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 6px;
		padding: 0.45rem;
		z-index: 6;
		backdrop-filter: blur(6px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
		font-family: var(--font-mono, ui-monospace, monospace);
		color: #e9ecf3;
	}
	svg {
		display: block;
		width: 100%;
		height: auto;
	}
	.cardinal {
		fill: rgba(255, 255, 255, 0.5);
		font-size: 12px;
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.readout {
		margin-top: 0.35rem;
		font-size: 0.62rem;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-variant-numeric: tabular-nums;
	}
	.badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
	}
	.badge.sun {
		color: #ffd166;
	}
	.badge.moon {
		color: #dde2ff;
	}
	.phase {
		margin-left: auto;
		opacity: 0.6;
	}
</style>
