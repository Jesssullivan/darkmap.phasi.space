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
	import {
		buildPhaseGradient,
		buildPhaseSegments,
		phaseAt,
		PHASE_DEFINITIONS,
		type TwilightPhaseSegment,
	} from '$lib/ephemeris/twilight-phases';

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

	// Twilight-phase segments (#197). The segment list is the contract;
	// the gradient and the per-phase popover hitboxes both derive from it.
	const phaseSegments = $derived<readonly TwilightPhaseSegment[]>(
		readout ? buildPhaseSegments(readout.events, fracOf) : [],
	);
	const bandGradient = $derived(buildPhaseGradient(phaseSegments));

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

	// Phase under the cursor + current time (the "now" staff). Drive the
	// header chip and any per-event narration that needs to know which
	// twilight band a marker falls inside.
	const cursorPhase = $derived(phaseAt(phaseSegments, cursorFrac));
	const nowPhase = $derived(nowFrac === null ? undefined : phaseAt(phaseSegments, nowFrac));

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

	type EventTipLabel = {
		readonly short: string;
		readonly long: string;
		readonly description: string;
	};

	const eventTipFor = (k: EphemerisEventKey): EventTipLabel => {
		switch (k) {
			case 'astronomicalDawn':
				return {
					short: 'astro',
					long: 'Astronomical dawn',
					description: 'Sun reaches −18° below the horizon. Astronomical twilight begins.',
				};
			case 'nauticalDawn':
				return {
					short: 'naut',
					long: 'Nautical dawn',
					description: 'Sun reaches −12° below the horizon. Horizon visible at sea.',
				};
			case 'civilDawn':
				return {
					short: 'civil',
					long: 'Civil dawn',
					description:
						'Sun reaches −6° below the horizon. Outdoor activities without artificial light become possible.',
				};
			case 'sunrise':
				return {
					short: '↑',
					long: 'Sunrise',
					description: 'Sun crosses the horizon. Civil twilight ends, daylight begins.',
				};
			case 'solarNoon':
				return {
					short: 'noon',
					long: 'Solar noon',
					description: 'Sun is at its highest altitude for the day at the viewport center.',
				};
			case 'sunset':
				return {
					short: '↓',
					long: 'Sunset',
					description: 'Sun crosses the horizon. Daylight ends, civil twilight begins.',
				};
			case 'civilDusk':
				return {
					short: 'civil',
					long: 'Civil dusk',
					description: 'Sun reaches −6° below the horizon. Nautical twilight begins.',
				};
			case 'nauticalDusk':
				return {
					short: 'naut',
					long: 'Nautical dusk',
					description: 'Sun reaches −12° below the horizon. Astronomical twilight begins.',
				};
			case 'astronomicalDusk':
				return {
					short: 'astro',
					long: 'Astronomical dusk',
					description: 'Sun reaches −18° below the horizon. Full astronomical darkness begins.',
				};
		}
	};

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
		<HelpTooltip
			text={cursorPhase
				? `Cursor sits in ${cursorPhase.label.toLowerCase()} — ${cursorPhase.description}`
				: 'Time cursor across the UTC day. Drag the rail or use arrow keys to scrub.'}
		>
			{#snippet trigger()}
				<span class="cursor-label">
					cursor {fmtClock(time)}
					{#if cursorPhase}
						<span class="phase-dot" style="background: {cursorPhase.color};" aria-hidden="true"></span>
						<span class="phase-name">{cursorPhase.label.toLowerCase()}</span>
					{/if}
				</span>
			{/snippet}
		</HelpTooltip>
		{#if nowPhase}
			<HelpTooltip text="Right now ({fmtClock(now)} UTC) is {nowPhase.label.toLowerCase()} — {nowPhase.description}">
				{#snippet trigger()}
					<span class="now-chip">
						<span class="phase-dot" style="background: {nowPhase.color};" aria-hidden="true"></span>
						now {fmtClock(now)}
					</span>
				{/snippet}
			</HelpTooltip>
		{/if}
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
			{#each ['astronomicalDawn', 'nauticalDawn', 'civilDawn', 'sunrise', 'solarNoon', 'sunset', 'civilDusk', 'nauticalDusk', 'astronomicalDusk'] as evKey, i (evKey)}
				{@const tip = eventTipFor(evKey as EphemerisEventKey)}
				{@const at = readout.events[evKey as EphemerisEventKey]}
				{#if i === 3 || i === 6}
					<span class="sep">·</span>
				{/if}
				<HelpTooltip text="{tip.long} {fmtClock(at)} UTC — {tip.description}">
					{#snippet trigger()}
						<span
							class="event-chip"
							class:sun-up={evKey === 'sunrise'}
							class:sun-down={evKey === 'sunset'}
							aria-label="{tip.long} {fmtClock(at)} UTC">{tip.short} {fmtClock(at)}</span
						>
					{/snippet}
				</HelpTooltip>
			{/each}
		</div>
		<div class="phase-legend" aria-label="Twilight phase legend">
			{#each Array.from(new Set(phaseSegments.map((s) => s.name))) as phaseName (phaseName)}
				{@const def = PHASE_DEFINITIONS[phaseName]}
				<HelpTooltip text="{def.label} — {def.description} ({def.altitudeRange})">
					{#snippet trigger()}
						<span class="phase-chip">
							<span class="phase-dot" style="background: {def.color};" aria-hidden="true"></span>
							{def.label.toLowerCase()}
						</span>
					{/snippet}
				</HelpTooltip>
			{/each}
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
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.now-chip {
		font-variant-numeric: tabular-nums;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.05rem 0.35rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(255, 255, 255, 0.06);
		color: rgba(233, 236, 243, 0.86);
		font-size: 0.6rem;
	}
	.phase-dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		border: 1px solid rgba(255, 255, 255, 0.35);
		display: inline-block;
		flex: 0 0 auto;
	}
	.phase-name {
		opacity: 0.85;
		text-transform: lowercase;
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
		background: var(--accent-amber);
		transform: translateX(-50%);
		box-shadow: 0 0 6px rgba(var(--accent-amber-rgb), 0.7);
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
		background: rgba(var(--accent-amber-rgb), 0.22);
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
	.event-chip {
		font-variant-numeric: tabular-nums;
		min-height: 1.1rem;
		padding: 0.05rem 0.3rem;
		border-radius: 4px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(255, 255, 255, 0.04);
		color: rgba(233, 236, 243, 0.85);
		display: inline-block;
	}
	.event-chip.sun-up,
	.event-chip.sun-down {
		color: var(--accent-amber);
		border-color: rgba(var(--accent-amber-rgb), 0.32);
		background: rgba(var(--accent-amber-rgb), 0.08);
	}
	.phase-legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-top: 0.35rem;
		font-size: 0.6rem;
		opacity: 0.85;
	}
	.phase-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		background: rgba(255, 255, 255, 0.05);
		color: rgba(233, 236, 243, 0.86);
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
		border-color: rgba(var(--accent-amber-rgb), 0.34);
		background: rgba(var(--accent-amber-rgb), 0.14);
		color: var(--accent-amber);
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
		background: rgba(var(--accent-amber-rgb), 0.12);
		border: 1px solid rgba(var(--accent-amber-rgb), 0.3);
		color: var(--accent-amber);
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
			/* The 9-event clock row would wrap onto two lines and crowd the
			   safe-area inset on phones. The phase-legend row below stays
			   visible and carries the popovers a mobile user actually needs. */
			display: none;
		}
		.phase-legend {
			/* Compact dots-only on phones; tap still opens the popover. */
			font-size: 0.58rem;
		}
		.now-chip,
		.cursor-label {
			font-size: 0.62rem;
		}
	}
</style>
