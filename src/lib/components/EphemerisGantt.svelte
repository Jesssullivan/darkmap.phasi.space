<script lang="ts">
	import { Effect } from 'effect';
	import { onDestroy, untrack } from 'svelte';
	import HelpTooltip from '$lib/components/HelpTooltip.svelte';
	import type { EphemerisReadout, LatLon } from '$lib/ephemeris/EphemerisClient';
	import { viewportRangesFor, type ViewportRangeSummarySource } from '$lib/ephemeris/viewportSummaryCache';
	import {
		makeEphemerisViewportSummaryRequest,
		type EphemerisEventKey,
		type EventRange,
		type EventRangeMap,
	} from '$lib/ephemeris/viewportSummary';

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
		zoom?: number;
		onTimeChange?: (t: Date) => void;
	}

	let { location, time, bounds, zoom, onTimeChange }: Props = $props();

	let readout = $state<EphemerisReadout | null>(null);
	let loading = $state(false);
	let bar: HTMLDivElement | undefined = $state();
	let dragging = $state(false);
	let now = $state(new Date());
	let online = $state(typeof navigator === 'undefined' ? true : navigator.onLine);

	// Per-event min..max range across a 4x4 grid sampled inside the
	// tile-cover summary for the current bounds.
	// Populated asynchronously after the center readout, so the gantt
	// renders the cursor + bands immediately and the uncertainty stripes
	// fade in once the corner samples settle.
	let ranges = $state<EventRangeMap>({});

	type RangeStatus =
		| { kind: 'idle' }
		| { kind: 'loading'; key: string }
		| { kind: 'refreshing'; key: string; previousKey: string }
		| { kind: 'ready'; computedAtMs: number; key: string; source: ViewportRangeSummarySource }
		| { kind: 'stale'; key: string; previousKey?: string }
		| { kind: 'error'; key: string };

	let rangeStatus = $state<RangeStatus>({ kind: 'idle' });
	let activeRangeKey = '';
	let hasDisplayedRanges = false;

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
	let readoutGen = 0;
	let rangeGen = 0;
	const dayKey = $derived(
		`${time.getUTCFullYear()}-${time.getUTCMonth()}-${time.getUTCDate()}|${location.lat.toFixed(3)},${location.lon.toFixed(3)}`,
	);
	$effect(() => {
		const myGen = ++readoutGen;
		loading = true;
		(async () => {
			try {
				const c = await loadClient();
				const r = await c(location, time);
				if (myGen === readoutGen) {
					readout = r;
					loading = false;
				}
			} catch (e) {
				if (myGen === readoutGen) {
					loading = false;
					console.warn('EphemerisGantt: failed to compute readout', e);
				}
			}
		})();
		// dayKey is the dependency; reading it inside $effect tracks it.
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		dayKey;
	});

	// Grid-sample across a coarse Web-Mercator tile cover, not the raw
	// viewport rectangle. Small mobile pans inside the same summary tile
	// cover reuse the same Promise and avoid churn in the dusk rail.
	const summaryRequest = $derived(bounds ? makeEphemerisViewportSummaryRequest({ bounds, mapZoom: zoom, time }) : null);
	const boundsKey = $derived(summaryRequest?.key ?? '');
	$effect(() => {
		const key = boundsKey;
		if (!key) {
			ranges = {};
			rangeStatus = { kind: 'idle' };
			activeRangeKey = '';
			hasDisplayedRanges = false;
			return;
		}
		const req = untrack(() => summaryRequest);
		if (!req) return;
		const reqTime = untrack(() => time);
		const myGen = ++rangeGen;
		const previousKey = activeRangeKey;
		rangeStatus =
			hasDisplayedRanges && previousKey && previousKey !== key
				? { kind: 'refreshing', key, previousKey }
				: { kind: 'loading', key };
		(async () => {
			const c = await loadClient();
			const summary = await viewportRangesFor(req, c, reqTime);
			if (myGen !== rangeGen) return;
			ranges = summary.ranges;
			activeRangeKey = summary.key;
			hasDisplayedRanges = Object.keys(summary.ranges).length > 0;
			rangeStatus = {
				kind: 'ready',
				key: summary.key,
				source: summary.source,
				computedAtMs: summary.computedAtMs,
			};
		})().catch((e) => {
			if (myGen === rangeGen) {
				rangeStatus = hasDisplayedRanges
					? { kind: 'stale', key, previousKey: activeRangeKey || undefined }
					: { kind: 'error', key };
				console.warn('EphemerisGantt: viewport sampling failed', e);
			}
		});
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		key;
	});

	onDestroy(() => {
		readoutGen++;
		rangeGen++;
	});

	$effect(() => {
		if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
		const updateOnline = () => {
			online = navigator.onLine;
		};
		window.addEventListener('online', updateOnline);
		window.addEventListener('offline', updateOnline);
		return () => {
			window.removeEventListener('online', updateOnline);
			window.removeEventListener('offline', updateOnline);
		};
	});

	$effect(() => {
		const id = setInterval(() => {
			now = new Date();
		}, 60_000);
		return () => clearInterval(id);
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
	const nowFrac = $derived(fracOf(now));

	const events = $derived(readout?.events);
	const noonAt: Date | null = $derived(events ? events.solarNoon : null);
	const sunriseAt: Date | null = $derived(events ? events.sunrise : null);
	const sunsetAt: Date | null = $derived(events ? events.sunset : null);
	const noonFrac = $derived(fracOf(noonAt));
	const sunriseFrac = $derived(fracOf(sunriseAt));
	const sunsetFrac = $derived(fracOf(sunsetAt));

	const timeFromClientX = (clientX: number): Date | null => {
		if (!bar || !onTimeChange) return null;
		const rect = bar.getBoundingClientRect();
		const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		return new Date(dayStart.getTime() + x * DAY_MS);
	};

	const setTimeFromClientX = (clientX: number): void => {
		const next = timeFromClientX(clientX);
		if (next) onTimeChange?.(next);
	};

	const handleClick = (ev: MouseEvent): void => {
		setTimeFromClientX(ev.clientX);
	};

	const handlePointerDown = (ev: PointerEvent): void => {
		if (!bar || !onTimeChange) return;
		ev.preventDefault();
		dragging = true;
		bar.setPointerCapture?.(ev.pointerId);
		setTimeFromClientX(ev.clientX);
	};

	const handlePointerMove = (ev: PointerEvent): void => {
		if (!dragging) return;
		ev.preventDefault();
		setTimeFromClientX(ev.clientX);
	};

	const handlePointerEnd = (ev: PointerEvent): void => {
		if (!dragging) return;
		dragging = false;
		bar?.releasePointerCapture?.(ev.pointerId);
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
	type Stripe = { key: EphemerisEventKey; left: number; width: number; deltaMin: number };
	const stripes = $derived.by((): Stripe[] => {
		const out: Stripe[] = [];
		for (const [key, range] of Object.entries(ranges) as [EphemerisEventKey, EventRange][]) {
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
		let best: { key: EphemerisEventKey; range: EventRange; distMs: number } | null = null;
		for (const [key, range] of Object.entries(ranges) as [EphemerisEventKey, EventRange][]) {
			const mid = (range.min.getTime() + range.max.getTime()) / 2;
			const dist = Math.abs(t - mid);
			if (!best || dist < best.distMs) best = { key, range, distMs: dist };
		}
		return best;
	});

	const labelFor = (k: EphemerisEventKey): string => {
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

	type RangeBadge = {
		readonly detail: string;
		readonly label: string;
		readonly tone: 'cached' | 'error' | 'live' | 'loading' | 'stale';
	};

	const fmtAge = (computedAtMs: number): string => {
		const ageMin = Math.max(0, Math.round((now.getTime() - computedAtMs) / 60_000));
		if (ageMin < 1) return 'just now';
		if (ageMin < 60) return `${ageMin}m ago`;
		return `${Math.round(ageMin / 60)}h ago`;
	};

	const rangeBadge = $derived.by((): RangeBadge | null => {
		switch (rangeStatus.kind) {
			case 'idle':
				return null;
			case 'loading':
				return {
					label: online ? 'loading' : 'offline',
					tone: 'loading',
					detail: online
						? 'Computing the tile-cover summary for this viewport.'
						: 'Browser reports offline while the tile-cover summary is loading.',
				};
			case 'refreshing':
				return {
					label: online ? 'updating' : 'offline stale',
					tone: 'stale',
					detail: 'Showing the previous tile-cover summary until the current viewport summary finishes.',
				};
			case 'ready':
				if (!online) {
					return {
						label: 'offline cache',
						tone: 'cached',
						detail: `Browser reports offline; using the latest local tile-cover summary from ${fmtAge(rangeStatus.computedAtMs)}.`,
					};
				}
				return rangeStatus.source === 'computed'
					? {
							label: 'live',
							tone: 'live',
							detail: 'Freshly computed tile-cover summary for the visible viewport.',
						}
					: {
							label: 'cache',
							tone: 'cached',
							detail: `Reused a local tile-cover summary computed ${fmtAge(rangeStatus.computedAtMs)}.`,
						};
			case 'stale':
				return {
					label: online ? 'stale' : 'offline stale',
					tone: 'stale',
					detail: 'The current viewport summary failed; the rail is keeping the previous tile-cover summary visible.',
				};
			case 'error':
				return {
					label: 'no range',
					tone: 'error',
					detail: 'The viewport summary failed. Point-level ephemeris can still render independently.',
				};
		}
	});
</script>

<div class="gantt" aria-label="Twilight strip for viewport center">
	<div class="header">
		<span class="date">{fmtDate(dayStart)} UTC</span>
		<span class="cursor-label">cursor {fmtClock(time)}</span>
		{#if rangeBadge}
			<HelpTooltip text={rangeBadge.detail}>
				{#snippet trigger()}
					<span
						class="cache-pill"
						class:cached={rangeBadge.tone === 'cached'}
						class:error={rangeBadge.tone === 'error'}
						class:live={rangeBadge.tone === 'live'}
						class:loading={rangeBadge.tone === 'loading'}
						class:stale={rangeBadge.tone === 'stale'}>{rangeBadge.label}</span
					>
				{/snippet}
			</HelpTooltip>
		{/if}
		{#if closestRange}
			<HelpTooltip>
				{#snippet trigger()}
					<span class="pill">
						{labelFor(closestRange.key)}
						{fmtClock(closestRange.range.min)}–{fmtClock(closestRange.range.max)}
						<span class="delta"
							>{fmtDelta((closestRange.range.max.getTime() - closestRange.range.min.getTime()) / 60_000)}</span
						>
					</span>
				{/snippet}
				{#snippet content()}
					<div>
						<strong>Event-time spread across the visible viewport.</strong>
						<br />
						Sampled at 16 points across the current tile-cover summary. Small pans inside that cover reuse the same cache
						entry; selected pins and GPS fixes stay point-precise.
					</div>
				{/snippet}
			</HelpTooltip>
		{/if}
		{#if readout}
			{@const moon = readout.moon}
			<HelpTooltip
				text="Moon phase angle {moon.phaseDeg.toFixed(1)}° · illumination {(moon.illumination * 100).toFixed(1)}%"
			>
				{#snippet trigger()}
					<span class="phase">
						{moon.phaseName} · {(moon.illumination * 100).toFixed(0)}%
					</span>
				{/snippet}
			</HelpTooltip>
		{:else if loading}
			<span class="phase">…</span>
		{/if}
	</div>
	<div
		class="bar"
		bind:this={bar}
		onclick={handleClick}
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerEnd}
		onpointercancel={handlePointerEnd}
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
		{#if nowFrac !== null}
			<span class="staff" style="left: {(nowFrac * 100).toFixed(2)}%;" title="Current time {fmtClock(now)} UTC"></span>
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
		/* Leave room for the MapToolbar's column on the right. */
		right: var(--map-toolbar-inset-rem, 5rem);
		bottom: calc(var(--gantt-bottom-rem, 0.75rem) + env(safe-area-inset-bottom, 0px));
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
		/* Bumped from 1rem so the touch target meets WCAG 2.5.5 (24x24px).
		   Desktop reads fine at 1.5rem too — the bands stay visible. */
		height: 1.5rem;
		border-radius: 3px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		cursor: pointer;
		touch-action: none;
		outline: none;
	}
	.bar:focus-visible {
		box-shadow: 0 0 0 2px rgba(127, 187, 255, 0.5);
	}
	@media (pointer: coarse) {
		.bar {
			/* Even more generous on touch devices. */
			height: 1.75rem;
		}
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
	.staff {
		position: absolute;
		top: -0.28rem;
		bottom: -0.28rem;
		width: 3px;
		background: #ffffff;
		transform: translateX(-50%);
		box-shadow:
			0 0 0 1px rgba(6, 8, 13, 0.85),
			0 0 8px rgba(255, 255, 255, 0.65);
		pointer-events: none;
	}
	.staff::before {
		content: 'now';
		position: absolute;
		top: -1rem;
		left: 50%;
		transform: translateX(-50%);
		color: rgba(255, 255, 255, 0.82);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.52rem;
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
	.cache-pill {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 1.1rem;
		padding: 0.05rem 0.35rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(255, 255, 255, 0.08);
		color: rgba(233, 236, 243, 0.86);
		font-size: 0.58rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.cache-pill.live {
		border-color: rgba(97, 220, 163, 0.38);
		background: rgba(97, 220, 163, 0.14);
		color: #b8f4d7;
	}
	.cache-pill.cached {
		border-color: rgba(127, 187, 255, 0.4);
		background: rgba(127, 187, 255, 0.14);
		color: #c7ddff;
	}
	.cache-pill.loading {
		border-color: rgba(255, 255, 255, 0.2);
		background: rgba(255, 255, 255, 0.09);
		color: rgba(233, 236, 243, 0.72);
	}
	.cache-pill.stale {
		border-color: rgba(255, 209, 102, 0.34);
		background: rgba(255, 209, 102, 0.14);
		color: #ffd166;
	}
	.cache-pill.error {
		border-color: rgba(255, 118, 117, 0.42);
		background: rgba(255, 118, 117, 0.14);
		color: #ffb5b4;
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
	@media (max-width: 820px) {
		.gantt {
			left: 0.75rem;
			right: var(--map-toolbar-inset-rem, 5rem);
			padding: 0.5rem 0.65rem;
		}
		.header {
			flex-wrap: wrap;
			gap: 0.35rem 0.6rem;
		}
		.events {
			display: none;
		}
	}
</style>
