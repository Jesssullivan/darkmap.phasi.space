<script lang="ts">
	import { Effect, Layer } from 'effect';
	import { onDestroy, onMount } from 'svelte';
	import { Compass, Moon, Sun } from '@lucide/svelte';
	import HelpTooltip from '$lib/components/HelpTooltip.svelte';
	import {
		makeOrientationServiceLive,
		OrientationService,
		orientationCapabilityFor,
		type OrientationWatch,
	} from '$lib/device/OrientationService';
	import { airmassKastenYoung, formatAirmass } from '$lib/ephemeris/airmass';
	import type { BodyPosition, EphemerisReadout, LatLon, SkyPositions } from '$lib/ephemeris/EphemerisClient';
	import type { HorizonPolygon } from '$lib/ephemeris/HorizonProvider';

	interface Props {
		location: LatLon;
		time: Date;
	}

	let { location, time }: Props = $props();

	// Device-orientation compass overlay (#102). Status machine:
	//   unknown      — pre-mount / SSR
	//   unsupported  — no DeviceOrientationEvent
	//   needs-permission — iOS Safari path; show "Enable compass" button
	//   granted      — desktop/Android path; start watch immediately
	//   active       — watch running, heading flowing
	//   denied       — user denied the permission prompt
	//   error        — watch start failed for another reason
	type CompassStatus = 'unknown' | 'unsupported' | 'needs-permission' | 'granted' | 'active' | 'denied' | 'error';
	let compassStatus = $state<CompassStatus>('unknown');
	let headingDeg = $state<number | null>(null);
	let compassWatch: OrientationWatch | undefined;
	let lastHeadingTs = 0;

	onMount(() => {
		const capability = orientationCapabilityFor({
			DeviceOrientationEvent: window.DeviceOrientationEvent as unknown as {
				readonly requestPermission?: () => Promise<'granted' | 'denied'>;
			},
		});
		compassStatus =
			capability === 'unsupported' ? 'unsupported' : capability === 'needs-permission' ? 'needs-permission' : 'granted';
		// Desktop/Android: no gesture required — start the watch on mount.
		if (compassStatus === 'granted') void startCompassWatch();
	});

	onDestroy(() => {
		compassWatch?.stop();
		compassWatch = undefined;
	});

	async function startCompassWatch(): Promise<void> {
		const layer = makeOrientationServiceLive({
			DeviceOrientationEvent: window.DeviceOrientationEvent as unknown as {
				readonly requestPermission?: () => Promise<'granted' | 'denied'>;
			},
			addEventListener: (type, listener) => window.addEventListener(type, listener),
			removeEventListener: (type, listener) => window.removeEventListener(type, listener),
		});
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* OrientationService;
				return yield* svc.watch((reading) => {
					// 8 Hz cap — DeviceOrientationEvent fires up to ~60 Hz on some
					// devices; the on-screen needle doesn't need that resolution.
					const now = Date.now();
					if (now - lastHeadingTs < 125) return;
					lastHeadingTs = now;
					headingDeg = reading.headingDeg;
				});
			}).pipe(Effect.provide(layer)),
		);
		if (exit._tag === 'Failure') {
			const err = (exit.cause as unknown as { error?: { reason?: string } }).error;
			compassStatus = err?.reason === 'denied' ? 'denied' : 'error';
			return;
		}
		compassWatch = exit.value;
		compassStatus = 'active';
	}

	async function enableCompass(): Promise<void> {
		const layer = makeOrientationServiceLive({
			DeviceOrientationEvent: window.DeviceOrientationEvent as unknown as {
				readonly requestPermission?: () => Promise<'granted' | 'denied'>;
			},
			addEventListener: (type, listener) => window.addEventListener(type, listener),
			removeEventListener: (type, listener) => window.removeEventListener(type, listener),
		});
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const svc = yield* OrientationService;
				return yield* svc.requestPermission();
			}).pipe(Effect.provide(layer)),
		);
		if (exit._tag === 'Failure') {
			const err = (exit.cause as unknown as { error?: { reason?: string } }).error;
			compassStatus = err?.reason === 'denied' ? 'denied' : 'error';
			return;
		}
		await startCompassWatch();
	}

	function compassButtonLabel(): string {
		switch (compassStatus) {
			case 'needs-permission':
				return 'Enable compass';
			case 'denied':
				return 'Compass denied';
			case 'error':
				return 'Compass error';
			case 'active':
				return `Compass on${headingDeg !== null ? ` (${Math.round(headingDeg)}°)` : ''}`;
			default:
				return '';
		}
	}

	let readout = $state<EphemerisReadout | null>(null);
	let trajectory = $state<{ frac: number; sun: BodyPosition }[]>([]);
	let horizon = $state<HorizonPolygon | null>(null);
	let horizonError = $state(false);

	type PositionFn = (loc: LatLon, t: Date) => Promise<SkyPositions>;
	type AtFn = (loc: LatLon, t: Date) => Promise<EphemerisReadout>;
	type HorizonFn = (loc: LatLon) => Promise<HorizonPolygon>;
	let clientPromise: Promise<{ positionAt: PositionFn; at: AtFn; horizonAt: HorizonFn }> | null = null;
	const loadClient = () => {
		if (!clientPromise) {
			clientPromise = (async () => {
				const [ephem, hp, tel] = await Promise.all([
					import('$lib/ephemeris/EphemerisClient'),
					import('$lib/ephemeris/HorizonProvider'),
					import('$lib/ephemeris/TerrariumElevationLookup'),
				]);
				const horizonLayer = hp.HorizonProviderLive.pipe(Layer.provide(tel.TerrariumElevationLookupLive));
				return {
					positionAt: (loc, t) =>
						Effect.runPromise(
							Effect.gen(function* () {
								const c = yield* ephem.EphemerisClient;
								return yield* c.positionAt(loc, t);
							}).pipe(Effect.provide(ephem.EphemerisClientLive)),
						),
					at: (loc, t) =>
						Effect.runPromise(
							Effect.gen(function* () {
								const c = yield* ephem.EphemerisClient;
								return yield* c.at(loc, t);
							}).pipe(Effect.provide(ephem.EphemerisClientLive)),
						),
					horizonAt: (loc) =>
						Effect.runPromise(
							Effect.gen(function* () {
								const h = yield* hp.HorizonProvider;
								return yield* h.polygonAt(loc);
							}).pipe(Effect.provide(horizonLayer)),
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

			// Kick off the horizon polygon fetch in parallel with the trajectory
			// finish — Terrarium tiles are slow on first visit so we don't block
			// the dot rendering on them. On error, fall back to a flat horizon.
			c.horizonAt(location)
				.then((poly) => {
					if (myGen !== cancelGen) return;
					horizon = poly;
					horizonError = false;
				})
				.catch((e) => {
					if (myGen !== cancelGen) return;
					horizon = null;
					horizonError = true;
					console.warn('SkyCompass: horizon polygon failed, falling back to flat', e);
				});
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
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
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

	// Horizon polygon as a closed SVG path. Each sample's (az, alt) maps
	// into the dome via polarXY; we close back to the first point so the
	// stroke draws a clean loop.
	const horizonPath = $derived.by(() => {
		if (!horizon || horizon.length < 3) return '';
		const pts = horizon.map((s) => polarXY(s.azimuthDeg, Math.max(s.altitudeDeg, -2)));
		return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z';
	});

	// Per-body horizon-relative altitude readout. When the body sits below
	// the local terrain horizon at its azimuth, mark it explicitly.
	const horizonAtAz = (azimuth: number): number | null => {
		if (!horizon || horizon.length === 0) return null;
		// Inline the wrap-and-interpolate from HorizonProvider.horizonAtAzimuth
		// to keep this component self-contained on the dynamic-import boundary.
		const az = ((azimuth % 360) + 360) % 360;
		for (let i = 0; i < horizon.length; i++) {
			const a = horizon[i];
			const b = horizon[(i + 1) % horizon.length];
			const aAz = a.azimuthDeg;
			const bAz = b.azimuthDeg <= aAz ? b.azimuthDeg + 360 : b.azimuthDeg;
			if (az >= aAz && az <= bAz) {
				const t = (az - aAz) / Math.max(1e-9, bAz - aAz);
				return a.altitudeDeg + t * (b.altitudeDeg - a.altitudeDeg);
			}
		}
		return horizon[0].altitudeDeg;
	};

	const sunHorizonDelta = $derived.by(() => {
		if (!cursor) return null;
		const h = horizonAtAz(cursor.sun.azimuthDeg);
		return h === null ? null : { horizonAlt: h, blocked: cursor.sun.altitudeDeg < h };
	});
	const moonHorizonDelta = $derived.by(() => {
		if (!cursor) return null;
		const h = horizonAtAz(cursor.moon.azimuthDeg);
		return h === null ? null : { horizonAlt: h, blocked: cursor.moon.altitudeDeg < h };
	});

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

		{#if horizonPath}
			<path d={horizonPath} fill="rgba(110, 78, 48, 0.35)" stroke="rgba(180, 130, 80, 0.75)" stroke-width="0.9" />
		{/if}

		{#if compassStatus === 'active' && headingDeg !== null}
			<!-- Device heading needle. Triangle from compass center pointing toward
			     the bearing the phone is facing. heading=0 → up (toward N). -->
			<g transform="rotate({headingDeg} {CX} {CY})" class="heading-needle">
				<line x1={CX} y1={CY} x2={CX} y2={CY - R + 4} stroke="rgba(255, 209, 102, 0.85)" stroke-width="2" />
				<polygon
					points="{CX},{CY - R - 2} {CX - 4},{CY - R + 8} {CX + 4},{CY - R + 8}"
					fill="rgba(255, 209, 102, 0.95)"
				/>
			</g>
		{/if}

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
			<span class="badge sun" aria-label="Sun"><Sun size={14} aria-hidden="true" /></span>
			<span>alt {fmtAlt(cursor?.sun.altitudeDeg)}</span>
			<span>az {fmtAz(cursor?.sun.azimuthDeg)}</span>
			{#if cursor && cursor.sun.altitudeDeg > 0}
				{@const sunAlt = cursor.sun.altitudeDeg}
				<HelpTooltip>
					{#snippet trigger()}
						<span class="airmass">X {formatAirmass(airmassKastenYoung(sunAlt))}</span>
					{/snippet}
					{#snippet content()}
						<div>
							<strong>Atmospheric airmass</strong> — Kasten &amp; Young (1989).
							<br />
							At zenith X=1.0, at 45° alt X≈1.41, at 10° alt X≈5.6. Above ~30° plane-parallel
							<code>sec(z)</code> is close enough; below that, curvature dominates.
							<br />
							<a href="/docs#science">/docs#science</a>
						</div>
					{/snippet}
				</HelpTooltip>
			{/if}
			{#if sunHorizonDelta?.blocked}
				<span class="blocked">behind terrain {fmtAlt(sunHorizonDelta.horizonAlt)}</span>
			{:else if sunHorizonDelta}
				<span class="horizon">h {fmtAlt(sunHorizonDelta.horizonAlt)}</span>
			{/if}
		</div>
		<div class="row">
			<span class="badge moon" aria-label="Moon"><Moon size={14} aria-hidden="true" /></span>
			<span>alt {fmtAlt(cursor?.moon.altitudeDeg)}</span>
			<span>az {fmtAz(cursor?.moon.azimuthDeg)}</span>
			{#if moonHorizonDelta?.blocked}
				<span class="blocked">behind terrain {fmtAlt(moonHorizonDelta.horizonAlt)}</span>
			{:else if moonHorizonDelta}
				<span class="horizon">h {fmtAlt(moonHorizonDelta.horizonAlt)}</span>
			{/if}
			{#if readout}
				<span class="phase">{readout.moon.phaseName}</span>
			{/if}
		</div>
		{#if horizonError}
			<div class="row note">terrain horizon unavailable — flat horizon assumed</div>
		{/if}
		{#if compassStatus === 'needs-permission'}
			<div class="row compass-row">
				<button type="button" class="compass-btn" onclick={enableCompass}>
					<Compass size={14} aria-hidden="true" />
					{compassButtonLabel()}
				</button>
			</div>
		{:else if compassStatus === 'active'}
			<div class="row compass-row" aria-live="polite">
				<span class="compass-status">
					<Compass size={14} aria-hidden="true" />
					{compassButtonLabel()}
				</span>
			</div>
		{:else if compassStatus === 'denied' || compassStatus === 'error'}
			<div class="row note">
				<Compass size={14} aria-hidden="true" />
				{compassButtonLabel()}
			</div>
		{/if}
	</div>
</div>

<style>
	.sky {
		position: fixed;
		/* Sit under the top-center geocoder search input so it doesn't
		   stack over it on narrow widths. */
		top: 3.75rem;
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
	/* Hide the dome on phone widths; the gantt + readout still cover
	   the use case. Future ticket: collapse into a tappable badge. */
	@media (max-width: 560px) {
		.sky {
			display: none;
		}
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
	.airmass {
		opacity: 0.7;
		color: #ffd166;
		font-variant-numeric: tabular-nums;
	}
	.horizon {
		opacity: 0.55;
	}
	.blocked {
		color: rgba(255, 120, 120, 0.85);
	}
	.note {
		opacity: 0.55;
		font-style: italic;
	}
	.compass-row {
		gap: 0.4rem;
		margin-top: 0.25rem;
	}
	.compass-btn {
		background: rgba(8, 10, 16, 0.85);
		color: #e9ecf3;
		border: 1px solid rgba(255, 209, 102, 0.45);
		border-radius: 999px;
		padding: 0.3rem 0.65rem;
		font: inherit;
		font-size: 0.75rem;
		cursor: pointer;
		min-height: 2.25rem;
	}
	.compass-btn:hover,
	.compass-btn:focus-visible {
		color: #ffd166;
		border-color: rgba(255, 209, 102, 0.85);
		outline: none;
	}
	.compass-status {
		color: rgba(255, 209, 102, 0.9);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}
	.heading-needle {
		transition: transform 0.12s linear;
		transform-origin: center;
	}
</style>
