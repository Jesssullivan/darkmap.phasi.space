<script lang="ts">
	import { Effect } from 'effect';
	import { onDestroy } from 'svelte';
	import type { EphemerisReadout, LatLon } from '$lib/ephemeris/EphemerisClient';
	import { viewportGridPoints } from '$lib/viewportGrid';

	export interface ViewportBounds {
		readonly north: number;
		readonly south: number;
		readonly east: number;
		readonly west: number;
	}

	interface Props {
		location: LatLon;
		time: Date;
		bounds?: ViewportBounds;
		onTimeChange?: (t: Date) => void;
	}

	let { location, time, bounds, onTimeChange }: Props = $props();

	let readout = $state<EphemerisReadout | null>(null);
	let loading = $state(false);
	let bar: HTMLDivElement | undefined = $state();

	// Per-event min..max range across a 4x4 grid sampled inside `bounds`.
	// Populated asynchronously after the center readout, so the gantt
	// renders the cursor + bands immediately and the uncertainty stripes
	// fade in once the corner samples settle.
	type EventKey =
		| 'astronomicalDawn'
		| 'nauticalDawn'
		| 'civilDawn'
		| 'sunrise'
		| 'solarNoon'
		| 'sunset'
		| 'civilDusk'
		| 'nauticalDusk'
		| 'astronomicalDusk';
	type EventRange = { readonly min: Date; readonly max: Date };
	let ranges = $state<Partial<Record<EventKey, EventRange>>>({});

	// Lazy-load astronomy-engine + EphemerisClient. The ~116 KB chunk only
	// ships once the overlay actually mounts.
	type Client = (loc: LatLon, t: Date) => Promise<EphemerisReadout>;
	let clientPromise: Promise<Client> | null = null;
	const loadClient = (): Promise<Client> => {
		if (!clientPromise) {
			clientPromise = (async () => {
				const mod = await import('$lib/ephemeris/EphemerisClient');
				return (loc, t) =>
					Effect.runPromise(
						Effect.gen(function* () {
							const c = yield* mod.EphemerisClient;
							return yield* c.at(loc, t);
						}).pipe(Effect.provide(mod.EphemerisClientLive)),
					);
			})();
		}
		return clientPromise;
	};

	// Recompute whenever location or the calendar-day part of `time` changes.
	// (Scrubbing within the same day moves the cursor but the band positions
	// are stable for the day.)
	let cancelGen = 0;
	const dayKey = $derived(
		`${time.getUTCFullYear()}-${time.getUTCMonth()}-${time.getUTCDate()}|${location.lat.toFixed(3)},${location.lon.toFixed(3)}`,
	);
	$effect(() => {
		const myGen = ++cancelGen;
		loading = true;
		(async () => {
			try {
				const c = await loadClient();
				const r = await c(location, time);
				if (myGen === cancelGen) {
					readout = r;
					loading = false;
				}
			} catch (e) {
				if (myGen === cancelGen) {
					loading = false;
					console.warn('EphemerisGantt: failed to compute readout', e);
				}
			}
		})();
		// dayKey is the dependency; reading it inside $effect tracks it.
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		dayKey;
	});

	// Grid-sample (4x4) across the viewport bounds to compute per-event
	// min..max ranges. Only fires when bounds is provided. Recomputes when
	// the bounds rect or the calendar day changes.
	const boundsKey = $derived(
		bounds
			? `${bounds.north.toFixed(3)},${bounds.south.toFixed(3)},${bounds.east.toFixed(3)},${bounds.west.toFixed(3)}`
			: '',
	);
	$effect(() => {
		if (!bounds) {
			ranges = {};
			return;
		}
		const myGen = ++cancelGen;
		(async () => {
			const c = await loadClient();
			// 4x4 grid plus the center pin. Skip if the box is degenerate.
			const points = viewportGridPoints(bounds, 4);
			if (points.length === 0) return;
			const readouts = await Promise.all(points.map((p) => c(p, time)));
			if (myGen !== cancelGen) return;
			const KEYS: EventKey[] = [
				'astronomicalDawn',
				'nauticalDawn',
				'civilDawn',
				'sunrise',
				'solarNoon',
				'sunset',
				'civilDusk',
				'nauticalDusk',
				'astronomicalDusk',
			];
			const next: Partial<Record<EventKey, EventRange>> = {};
			for (const k of KEYS) {
				let min = Infinity;
				let max = -Infinity;
				for (const r of readouts) {
					const d = r.events[k];
					if (!d) continue;
					const t = d.getTime();
					if (t < min) min = t;
					if (t > max) max = t;
				}
				if (Number.isFinite(min) && Number.isFinite(max)) {
					next[k] = { min: new Date(min), max: new Date(max) };
				}
			}
			ranges = next;
		})().catch((e) => {
			if (myGen === cancelGen) console.warn('EphemerisGantt: viewport sampling failed', e);
		});
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		boundsKey;
	});

	onDestroy(() => {
		cancelGen++;
	});

	// Strip covers a full UTC day for the date of `time`. Every twilight
	// event for that day is guaranteed to land somewhere in [0, 1].
	const dayStart = $derived(
		new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate(), 0, 0, 0, 0)),
	);
	const DAY_MS = 24 * 3600 * 1000;

	const fracOf = (d: Date | null): number | null => {
		if (!d) return null;
		const dt = d.getTime() - dayStart.getTime();
		if (dt < 0 || dt > DAY_MS) return null;
		return dt / DAY_MS;
	};

	// Twilight-strip color palette (Photographer's Ephemeris-ish).
	const COLOR = {
		night: '#06080d',
		astro: '#0c1633',
		nautical: '#1f3a73',
		civil: '#d18b3a',
		day: '#7fbbff',
	};

	type Stop = { frac: number; color: string };

	const bandGradient = $derived.by((): string => {
		if (!readout) return COLOR.night;
		const e = readout.events;
		// Build the gradient as a sequence of hard color stops. Missing
		// events (polar day/night) hold the surrounding color.
		const stops: Stop[] = [{ frac: 0, color: COLOR.night }];
		const push = (f: number | null, before: string, after: string) => {
			if (f === null) return;
			stops.push({ frac: f, color: before });
			stops.push({ frac: f, color: after });
		};
		push(fracOf(e.astronomicalDawn), COLOR.night, COLOR.astro);
		push(fracOf(e.nauticalDawn), COLOR.astro, COLOR.nautical);
		push(fracOf(e.civilDawn), COLOR.nautical, COLOR.civil);
		push(fracOf(e.sunrise), COLOR.civil, COLOR.day);
		push(fracOf(e.sunset), COLOR.day, COLOR.civil);
		push(fracOf(e.civilDusk), COLOR.civil, COLOR.nautical);
		push(fracOf(e.nauticalDusk), COLOR.nautical, COLOR.astro);
		push(fracOf(e.astronomicalDusk), COLOR.astro, COLOR.night);
		stops.push({ frac: 1, color: stops[stops.length - 1]?.color ?? COLOR.night });
		return 'linear-gradient(to right, ' + stops.map((s) => `${s.color} ${(s.frac * 100).toFixed(2)}%`).join(', ') + ')';
	});

	const cursorFrac = $derived.by(() => {
		const f = fracOf(time);
		return f === null ? 0 : f;
	});

	const events = $derived(readout?.events);
	const noonAt: Date | null = $derived(events ? events.solarNoon : null);
	const sunriseAt: Date | null = $derived(events ? events.sunrise : null);
	const sunsetAt: Date | null = $derived(events ? events.sunset : null);
	const noonFrac = $derived(fracOf(noonAt));
	const sunriseFrac = $derived(fracOf(sunriseAt));
	const sunsetFrac = $derived(fracOf(sunsetAt));

	const handleClick = (ev: MouseEvent): void => {
		if (!bar || !onTimeChange) return;
		const rect = bar.getBoundingClientRect();
		const x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
		onTimeChange(new Date(dayStart.getTime() + x * DAY_MS));
	};

	const handleKey = (ev: KeyboardEvent): void => {
		if (!onTimeChange) return;
		const minute = 60 * 1000;
		const step = ev.shiftKey ? 60 * minute : 15 * minute;
		if (ev.key === 'ArrowLeft') {
			ev.preventDefault();
			onTimeChange(new Date(time.getTime() - step));
		} else if (ev.key === 'ArrowRight') {
			ev.preventDefault();
			onTimeChange(new Date(time.getTime() + step));
		}
	};

	const fmtClock = (d: Date | null): string => {
		if (!d) return '—';
		const hh = d.getUTCHours().toString().padStart(2, '0');
		const mm = d.getUTCMinutes().toString().padStart(2, '0');
		return `${hh}:${mm}`;
	};

	const fmtDate = (d: Date): string => {
		const pad = (n: number) => n.toString().padStart(2, '0');
		return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	};

	// Six tick labels every 4 UTC hours.
	const TICKS = [0, 4, 8, 12, 16, 20, 24];

	// Uncertainty stripes — pairs of (left%, width%) for each event whose
	// viewport-range spans more than 1 minute.
	type Stripe = { key: EventKey; left: number; width: number; deltaMin: number };
	const stripes = $derived.by((): Stripe[] => {
		const out: Stripe[] = [];
		for (const [key, range] of Object.entries(ranges) as [EventKey, EventRange][]) {
			const minF = fracOf(range.min);
			const maxF = fracOf(range.max);
			if (minF === null || maxF === null) continue;
			const deltaMs = range.max.getTime() - range.min.getTime();
			if (deltaMs < 60 * 1000) continue;
			out.push({
				key,
				left: minF,
				width: Math.max(0, maxF - minF),
				deltaMin: deltaMs / 60_000,
			});
		}
		return out;
	});

	// Range pill — pick the event closest to the cursor and surface its
	// span as "civil dusk Δ 26 min" in the header.
	const closestRange = $derived.by(() => {
		const t = time.getTime();
		let best: { key: EventKey; range: EventRange; distMs: number } | null = null;
		for (const [key, range] of Object.entries(ranges) as [EventKey, EventRange][]) {
			const mid = (range.min.getTime() + range.max.getTime()) / 2;
			const dist = Math.abs(t - mid);
			if (!best || dist < best.distMs) best = { key, range, distMs: dist };
		}
		return best;
	});

	const labelFor = (k: EventKey): string => {
		switch (k) {
			case 'astronomicalDawn':
				return 'astro dawn';
			case 'nauticalDawn':
				return 'naut dawn';
			case 'civilDawn':
				return 'civil dawn';
			case 'sunrise':
				return 'sunrise';
			case 'solarNoon':
				return 'solar noon';
			case 'sunset':
				return 'sunset';
			case 'civilDusk':
				return 'civil dusk';
			case 'nauticalDusk':
				return 'naut dusk';
			case 'astronomicalDusk':
				return 'astro dusk';
		}
	};

	const fmtDelta = (deltaMin: number): string =>
		deltaMin < 60 ? `Δ ${Math.round(deltaMin)} min` : `Δ ${(deltaMin / 60).toFixed(1)} h`;
</script>

<div class="gantt" aria-label="Twilight strip for viewport center">
	<div class="header">
		<span class="date">{fmtDate(dayStart)} UTC</span>
		<span class="cursor-label">cursor {fmtClock(time)}</span>
		{#if closestRange}
			<span class="pill" title="Spread across visible viewport (4x4 sample grid)">
				{labelFor(closestRange.key)}
				{fmtClock(closestRange.range.min)}–{fmtClock(closestRange.range.max)}
				<span class="delta"
					>{fmtDelta((closestRange.range.max.getTime() - closestRange.range.min.getTime()) / 60_000)}</span
				>
			</span>
		{/if}
		<span class="phase" title="Moon illumination">
			{#if readout}
				{readout.moon.phaseName} · {(readout.moon.illumination * 100).toFixed(0)}%
			{:else if loading}
				…
			{/if}
		</span>
	</div>
	<div
		class="bar"
		bind:this={bar}
		onclick={handleClick}
		onkeydown={handleKey}
		role="slider"
		tabindex="0"
		aria-label="Time scrubber (UTC day)"
		aria-valuemin={0}
		aria-valuemax={24 * 60}
		aria-valuenow={time.getUTCHours() * 60 + time.getUTCMinutes()}
		aria-valuetext={fmtClock(time) + ' UTC'}
		style="background: {bandGradient};"
	>
		{#each stripes as s (s.key)}
			<span
				class="stripe"
				style="left: {(s.left * 100).toFixed(2)}%; width: {(s.width * 100).toFixed(2)}%;"
				title="{labelFor(s.key)} {fmtDelta(s.deltaMin)} across viewport"
			></span>
		{/each}
		{#if sunriseFrac !== null}
			<span
				class="event sunrise"
				style="left: {(sunriseFrac * 100).toFixed(2)}%;"
				title="Sunrise {fmtClock(sunriseAt)} UTC"
			></span>
		{/if}
		{#if noonFrac !== null}
			<span class="event noon" style="left: {(noonFrac * 100).toFixed(2)}%;" title="Solar noon {fmtClock(noonAt)} UTC"
			></span>
		{/if}
		{#if sunsetFrac !== null}
			<span class="event sunset" style="left: {(sunsetFrac * 100).toFixed(2)}%;" title="Sunset {fmtClock(sunsetAt)} UTC"
			></span>
		{/if}
		<span class="cursor" style="left: {(cursorFrac * 100).toFixed(2)}%;" aria-hidden="true"></span>
	</div>
	<div class="ticks" aria-hidden="true">
		{#each TICKS as h (h)}
			<span class="tick" style="left: {((h / 24) * 100).toFixed(2)}%;">{h.toString().padStart(2, '0')}</span>
		{/each}
	</div>
	{#if readout}
		<div class="events" aria-label="Twilight events for the day in UTC">
			<span>astro {fmtClock(readout.events.astronomicalDawn)}</span>
			<span>naut {fmtClock(readout.events.nauticalDawn)}</span>
			<span>civil {fmtClock(readout.events.civilDawn)}</span>
			<span class="sep">·</span>
			<span class="sun-up">↑ {fmtClock(readout.events.sunrise)}</span>
			<span>noon {fmtClock(readout.events.solarNoon)}</span>
			<span class="sun-down">↓ {fmtClock(readout.events.sunset)}</span>
			<span class="sep">·</span>
			<span>civil {fmtClock(readout.events.civilDusk)}</span>
			<span>naut {fmtClock(readout.events.nauticalDusk)}</span>
			<span>astro {fmtClock(readout.events.astronomicalDusk)}</span>
		</div>
	{/if}
</div>

<style>
	.gantt {
		position: fixed;
		left: 1rem;
		right: 1rem;
		bottom: var(--gantt-bottom-rem, 1rem);
		background: rgba(8, 10, 16, 0.85);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 6px;
		padding: 0.55rem 0.75rem;
		color: #e9ecf3;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.7rem;
		z-index: 6;
		pointer-events: auto;
		backdrop-filter: blur(6px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
	}
	.header {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.4rem;
		font-size: 0.65rem;
		opacity: 0.85;
	}
	.cursor-label {
		font-variant-numeric: tabular-nums;
	}
	.bar {
		position: relative;
		height: 1rem;
		border-radius: 3px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		cursor: pointer;
		outline: none;
	}
	.bar:focus {
		box-shadow: 0 0 0 2px rgba(127, 187, 255, 0.5);
	}
	.cursor {
		position: absolute;
		top: -0.15rem;
		bottom: -0.15rem;
		width: 2px;
		background: #ffd166;
		transform: translateX(-50%);
		box-shadow: 0 0 6px rgba(255, 209, 102, 0.7);
	}
	.stripe {
		position: absolute;
		top: 0;
		bottom: 0;
		background: rgba(255, 209, 102, 0.22);
		mix-blend-mode: screen;
		pointer-events: none;
	}
	.event {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		transform: translateX(-50%);
		background: rgba(255, 255, 255, 0.85);
	}
	.event.noon {
		background: rgba(255, 255, 255, 0.5);
	}
	.ticks {
		position: relative;
		height: 0.9rem;
		margin-top: 0.25rem;
	}
	.tick {
		position: absolute;
		transform: translateX(-50%);
		opacity: 0.5;
		font-size: 0.6rem;
		font-variant-numeric: tabular-nums;
	}
	.tick:first-child {
		transform: translateX(0);
	}
	.tick:last-child {
		transform: translateX(-100%);
	}
	.events {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-top: 0.35rem;
		opacity: 0.75;
		font-size: 0.62rem;
	}
	.events .sep {
		opacity: 0.4;
	}
	.events .sun-up,
	.events .sun-down {
		color: #ffd166;
	}
	.phase {
		opacity: 0.7;
	}
	.pill {
		display: inline-flex;
		gap: 0.35rem;
		align-items: baseline;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		background: rgba(255, 209, 102, 0.12);
		border: 1px solid rgba(255, 209, 102, 0.3);
		color: #ffd166;
		font-variant-numeric: tabular-nums;
		font-size: 0.62rem;
	}
	.pill .delta {
		opacity: 0.7;
		color: #e9ecf3;
	}
</style>
