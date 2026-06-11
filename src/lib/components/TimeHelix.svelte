<script module lang="ts">
	/**
	 * TimeHelix — the twilight gantt's successor (and the seed of phasi.space's
	 * foundational UI). A now-centered helical time ribbon: one revolution = 24h
	 * of local mean solar time, the axis = the passage of time. Twilight phases
	 * color the ribbon; sun/moon events ride it as nodules. The 24h "day view"
	 * is a Hann window CENTERED on the cursor — never a hard UTC-day strip.
	 *
	 * All math lives in `$lib/ephemeris/time-helix` (pure, node-tested); this
	 * component owns measurement, fetching, painting, and interaction.
	 *
	 * Contract kept from the gantt (browser smokes + e2e key off these):
	 * `.gantt` root, `.bar` slider (aria-valuenow = cursor UTC minutes-of-day),
	 * `.stripe` ribbon segments (+ `data-phase`), the fixed-float CSS block, and
	 * the ResponsiveDock `.dock-gantt-row :global(.gantt)` de-float overrides.
	 */
	import { Effect } from 'effect';
	import type { EphemerisReadout, LatLon } from '$lib/ephemeris/EphemerisClient';

	// Lazy-load astronomy-engine + EphemerisClient. The ~116 KB chunk only
	// ships once the overlay actually mounts. (Ported from the gantt.)
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

	// Module-level day-readout LRU: `dayStartMs|lat,lon` (3-decimal rounding,
	// the gantt's dayKey idiom) → readout. Scrubbing across the same days and
	// remounting the dock both hit this instead of recomputing the ephemeris.
	const READOUT_LRU_MAX = 8;
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- module-level cache, not reactive UI state
	const readoutLru = new Map<string, EphemerisReadout>();
	const lruGet = (k: string): EphemerisReadout | undefined => {
		const v = readoutLru.get(k);
		if (v) {
			readoutLru.delete(k);
			readoutLru.set(k, v);
		}
		return v;
	};
	const lruSet = (k: string, v: EphemerisReadout): void => {
		readoutLru.delete(k);
		readoutLru.set(k, v);
		if (readoutLru.size > READOUT_LRU_MAX) {
			const oldest = readoutLru.keys().next().value;
			if (oldest !== undefined) readoutLru.delete(oldest);
		}
	};

	// Per-instance uid for the SVG gradient/mask ids (two helixes on one page
	// must not share defs).
	let helixUid = 0;
</script>

<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Popover } from '@skeletonlabs/skeleton-svelte';
	import HelpTooltip from '$lib/components/HelpTooltip.svelte';
	import { portal } from '$lib/actions/portal';
	import {
		buildDaySegments,
		buildNodules,
		buildRibbonSegments,
		DAY_MS,
		depthAlpha,
		fmtClockLocal,
		fmtClockUtc,
		hannStops,
		helixPoint,
		helixScales,
		HOUR_MS,
		NEUTRAL_COLOR,
		phaseAtMs,
		SPAN_HOURS,
		stitchDaySegments,
		utcDayStart,
		visibleUtcDayStarts,
		type DayEvents,
		type DaySegments,
		type HelixGeometry,
		type HelixOrientation,
	} from '$lib/ephemeris/time-helix';

	export interface ViewportBounds {
		readonly north: number;
		readonly south: number;
		readonly east: number;
		readonly west: number;
	}

	interface Props {
		location: LatLon;
		time: Date;
		onTimeChange?: (t: Date) => void;
		/** Accepted for call-site/prop parity with the gantt; unused in V1
		 * (the viewport-spread rail returns in a later PR). */
		bounds?: ViewportBounds;
		zoom?: number;
		orientation?: HelixOrientation;
		spanHours?: number;
	}

	let {
		location,
		time,
		onTimeChange,
		bounds: _bounds,
		zoom: _zoom,
		orientation = 'horizontal',
		spanHours = SPAN_HOURS,
	}: Props = $props();

	const uid = ++helixUid;
	const gradId = `time-helix-hann-${uid}`;
	const maskId = `time-helix-mask-${uid}`;

	/** Extra data slack beyond the visible half-span: the cursor may drift this
	 * far from the last build center before segments/nodules rebuild. */
	const DATA_MARGIN_H = 6;

	const horizontal = $derived(orientation === 'horizontal');
	const cursorMs = $derived(time.getTime());

	/* ── geometry: measured .bar box, epoch-anchored absolute coords ────── */

	// Axis epoch is FIXED at mount-day UTC midnight; everything on the tape is
	// absolute against it and the viewport pans via one translate.
	const epochMs = utcDayStart(Date.now());

	let barEl: HTMLDivElement | undefined = $state();
	let boxW = $state(0);
	let boxH = $state(0);

	$effect(() => {
		if (!barEl || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) {
				boxW = entry.contentRect.width;
				boxH = entry.contentRect.height;
			}
		});
		ro.observe(barEl);
		return () => ro.disconnect();
	});

	// lonDeg rounded to 0.1° (= 24s of solar time, ~0.1px at strip scale):
	// the raw viewport lon changes every map-pan frame, and an exact dependency
	// would rebuild all ~210 ribbon segments per frame for an invisible shift.
	const lonDeg = $derived(Math.round(location.lon * 10) / 10);
	const geom = $derived.by((): HelixGeometry | null =>
		boxW > 0 && boxH > 0 ? { width: boxW, height: boxH, spanHours, epochMs, lonDeg, orientation } : null,
	);
	const scales = $derived(geom ? helixScales(geom) : null);
	const axisLen = $derived(horizontal ? boxW : boxH);
	const msPerPx = $derived(scales ? HOUR_MS / scales.pxPerHour : 0);

	// The single pan translate that centers the cursor. Scrubbing updates ONLY
	// this (plus the clock strings) — never the segment lists.
	const panPx = $derived(scales ? axisLen / 2 - ((cursorMs - epochMs) / HOUR_MS) * scales.pxPerHour : 0);
	const panTransform = $derived(horizontal ? `translate(${panPx}px, 0)` : `translate(0, ${panPx}px)`);

	const stops = $derived(hannStops(spanHours));

	/* ── data window: rebuild only on >6h drift / day-set / geometry ────── */

	// Seeded from the cursor prop (not wall-clock now): a time-traveled mount
	// must not paint one neutral frame before the drift effect catches up.
	// Initial-value capture is the point — the drift effect below tracks `time`.
	// svelte-ignore state_referenced_locally
	let buildCenterMs = $state(time.getTime());
	$effect(() => {
		const c = cursorMs;
		if (Math.abs(c - buildCenterMs) > DATA_MARGIN_H * HOUR_MS) buildCenterMs = c;
	});

	const windowHalfMs = $derived((spanHours / 2 + DATA_MARGIN_H) * HOUR_MS);
	const windowFromMs = $derived(buildCenterMs - windowHalfMs);
	const windowToMs = $derived(buildCenterMs + windowHalfMs);

	// UTC days intersecting the slack window (margin = the drift allowance, so
	// a 6h scrub never outruns the loaded days).
	const dayStarts = $derived(visibleUtcDayStarts(buildCenterMs, spanHours, DATA_MARGIN_H));
	const locKey = $derived(`${location.lat.toFixed(3)},${location.lon.toFixed(3)}`);

	/* ── day pipeline: fetch readouts in day order, seam-chained ────────── */

	let dayData = $state<ReadonlyMap<number, EphemerisReadout>>(new Map());
	let fetchGen = 0;

	$effect(() => {
		const days = dayStarts;
		const key = locKey;
		const myGen = ++fetchGen;
		(async () => {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local accumulator; published via immutable snapshots
			const have = new Map<number, EphemerisReadout>();
			for (const d of days) {
				const lruKey = `${d}|${key}`;
				let r = lruGet(lruKey);
				if (!r) {
					const c = await loadClient();
					// `location` is read after the await on purpose: only the rounded
					// locKey is a tracked dependency (the gantt's dayKey idiom).
					r = await c(location, new Date(d));
					if (myGen !== fetchGen) return;
					lruSet(lruKey, r);
				}
				have.set(d, r);
				// Publish incrementally so the ribbon colors day-by-day; the
				// chronological loop preserves the seam invariant downstream.
				dayData = new Map(have);
			}
		})().catch((e) => {
			if (myGen === fetchGen) console.warn('TimeHelix: ephemeris fetch failed', e);
		});
	});

	const loading = $derived(dayStarts.some((d) => !dayData.has(d)));

	// Seam invariant: day k+1's initial phase = day k's final phase, chained IN
	// DAY ORDER. A missing middle day breaks the chain honestly (no fabricated
	// midnight phase — the next loaded day reseeds from 'night').
	const stitched = $derived.by(() => {
		const built: DaySegments[] = [];
		let prev: DaySegments | undefined;
		for (const d of dayStarts) {
			const r = dayData.get(d);
			if (!r) {
				prev = undefined;
				continue;
			}
			const day = buildDaySegments(d, r.events, prev && prev.dayStartMs === d - DAY_MS ? prev.segments : undefined);
			built.push(day);
			prev = day;
		}
		return stitchDaySegments(built);
	});

	// Ribbon segments in epoch-anchored absolute coords. Pre-data the math
	// yields NEUTRAL_COLOR placeholders, so `.stripe` elements exist before
	// the ephemeris lands.
	const ribbon = $derived(geom ? buildRibbonSegments(stitched, geom, windowFromMs, windowToMs) : []);
	const backSegments = $derived(ribbon.filter((s) => !s.front));
	const frontSegments = $derived(ribbon.filter((s) => s.front));

	const nodules = $derived.by(() => {
		const daysEvents: DayEvents[] = [];
		for (const d of dayStarts) {
			const r = dayData.get(d);
			if (r) daysEvents.push(r.events);
		}
		return buildNodules(daysEvents, windowFromMs, windowToMs);
	});
	const noduleViews = $derived.by(() => {
		if (!geom || !scales) return [];
		return nodules.map((n) => {
			const p = helixPoint(n.tMs, geom, scales);
			return {
				id: `${n.key}-${n.tMs}`,
				n,
				x: p.x,
				y: p.y,
				alpha: depthAlpha(p.z),
				glow: n.key === 'sunrise' || n.key === 'sunset',
			};
		});
	});

	const cursorPhase = $derived(phaseAtMs(stitched, cursorMs));
	const cursorDayReadout = $derived(dayData.get(utcDayStart(cursorMs)) ?? null);

	/* ── NOW vs cursor ──────────────────────────────────────────────────── */

	let now = $state(new Date());
	$effect(() => {
		const id = setInterval(() => {
			now = new Date();
		}, 30_000);
		return () => clearInterval(id);
	});

	const nowMs = $derived(now.getTime());
	const nowAxisPx = $derived(scales ? ((nowMs - epochMs) / HOUR_MS) * scales.pxPerHour : 0);
	/** Cursor and wall-clock now coincide (un-scrubbed). */
	const coincident = $derived(Math.abs(cursorMs - nowMs) < 60_000);
	const nowDeltaMs = $derived(nowMs - cursorMs);
	const visibleHalfMs = $derived((spanHours / 2) * HOUR_MS);
	const nowOffEdge = $derived(nowDeltaMs > visibleHalfMs ? 1 : nowDeltaMs < -visibleHalfMs ? -1 : 0);

	let recentering = $state(false);
	let recenterTimer: ReturnType<typeof setTimeout> | undefined;
	const recenter = (): void => {
		recentering = true;
		onTimeChange?.(new Date());
		clearTimeout(recenterTimer);
		recenterTimer = setTimeout(() => {
			recentering = false;
		}, 320);
	};

	/* ── interaction: tape drag / tap-to-jump / keyboard ────────────────── */

	type DragState = {
		id: number;
		p0: number;
		c0: number;
		t0: number;
		claimed: boolean;
		touch: boolean;
	};
	let drag: DragState | null = null;
	let dragging = $state(false);
	let rafId = 0;
	let pendingAxisPx: number | null = null;

	const axisOf = (ev: PointerEvent): number => (horizontal ? ev.clientX : ev.clientY);
	const crossOf = (ev: PointerEvent): number => (horizontal ? ev.clientY : ev.clientX);

	const flushScrub = (): void => {
		rafId = 0;
		if (pendingAxisPx === null || !drag || !msPerPx) return;
		const next = drag.t0 + (drag.p0 - pendingAxisPx) * msPerPx;
		pendingAxisPx = null;
		onTimeChange?.(new Date(next));
	};

	const handlePointerDown = (ev: PointerEvent): void => {
		if (!onTimeChange || !barEl || !msPerPx) return;
		drag = {
			id: ev.pointerId,
			p0: axisOf(ev),
			c0: crossOf(ev),
			t0: cursorMs,
			claimed: false,
			touch: ev.pointerType === 'touch',
		};
		barEl.setPointerCapture?.(ev.pointerId);
	};

	const handlePointerMove = (ev: PointerEvent): void => {
		if (!drag || ev.pointerId !== drag.id) return;
		const p = axisOf(ev);
		const dAxis = p - drag.p0;
		const dCross = crossOf(ev) - drag.c0;
		if (!drag.claimed) {
			// Slope-claiming: 4px mouse slop, ~8px on touch. A touch gesture that
			// reads as vertical is released so it reaches the dock sheet beneath
			// (touch-action: pan-y lets the browser keep scrolling it).
			const slop = drag.touch ? 8 : 4;
			if (Math.max(Math.abs(dAxis), Math.abs(dCross)) < slop) return;
			if (drag.touch && Math.abs(dCross) > Math.abs(dAxis)) {
				barEl?.releasePointerCapture?.(drag.id);
				drag = null;
				return;
			}
			drag.claimed = true;
			dragging = true;
		}
		ev.preventDefault();
		pendingAxisPx = p;
		if (!rafId) rafId = requestAnimationFrame(flushScrub);
	};

	const handlePointerEnd = (ev: PointerEvent): void => {
		if (!drag || ev.pointerId !== drag.id) return;
		const wasClaimed = drag.claimed;
		// A scrub queued for the next frame must not be dropped by the release:
		// a fast flick can land pointerup before the rAF fires, and the throttle
		// would silently discard the gesture's final position.
		if (wasClaimed && pendingAxisPx !== null) {
			if (rafId) cancelAnimationFrame(rafId);
			flushScrub();
		}
		barEl?.releasePointerCapture?.(drag.id);
		if (!wasClaimed && ev.type === 'pointerup' && barEl && onTimeChange && msPerPx) {
			// Tap-to-jump: the tapped axis position maps through the centered tape.
			const rect = barEl.getBoundingClientRect();
			const center = horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
			onTimeChange(new Date(cursorMs + (axisOf(ev) - center) * msPerPx));
		}
		drag = null;
		dragging = false;
		pendingAxisPx = null;
	};

	const handleKey = (ev: KeyboardEvent): void => {
		if (!onTimeChange) return;
		if (ev.key === 'Home') {
			ev.preventDefault();
			recenter();
			return;
		}
		const step = (ev.shiftKey ? 60 : 15) * 60_000;
		if (ev.key === 'ArrowLeft') {
			ev.preventDefault();
			onTimeChange(new Date(cursorMs - step));
		} else if (ev.key === 'ArrowRight') {
			ev.preventDefault();
			onTimeChange(new Date(cursorMs + step));
		}
	};

	onDestroy(() => {
		fetchGen++;
		if (rafId) cancelAnimationFrame(rafId);
		clearTimeout(recenterTimer);
	});

	/* ── header labels ──────────────────────────────────────────────────── */

	const fmtDayShort = (d: Date): string => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	const utcOffsetLabel = (d: Date): string => {
		const offMin = -d.getTimezoneOffset();
		const sign = offMin < 0 ? '−' : '+';
		const abs = Math.abs(offMin);
		const h = Math.floor(abs / 60);
		const m = abs % 60;
		return `UTC${sign}${h}${m ? `:${m.toString().padStart(2, '0')}` : ''}`;
	};
	const dateSpanLabel = $derived.by(() => {
		const a = new Date(cursorMs - visibleHalfMs);
		const b = new Date(cursorMs + visibleHalfMs);
		return `${fmtDayShort(a)} → ${fmtDayShort(b)} · ${utcOffsetLabel(time)}`;
	});

	const ariaValueText = $derived(
		`${fmtClockLocal(time)} local · ${fmtClockUtc(time)} UTC — ${cursorPhase?.label.toLowerCase() ?? 'loading'}`,
	);
</script>

<div class="gantt time-helix" aria-label="Twilight strip for viewport center">
	<div class="header">
		<HelpTooltip
			text={cursorPhase
				? `Cursor sits in ${cursorPhase.label.toLowerCase()} — ${cursorPhase.description}`
				: 'Time cursor on the helix. Drag the ribbon or use arrow keys to scrub; Home returns to now.'}
		>
			{#snippet trigger()}
				<span class="clock-chip" title={cursorPhase?.description}>
					{fmtClockLocal(time)}
					<span class="phase-dot" style="background: {cursorPhase?.color ?? NEUTRAL_COLOR};" aria-hidden="true"></span>
				</span>
			{/snippet}
		</HelpTooltip>
		{#if !coincident}
			<button type="button" class="recenter-chip" onclick={recenter} aria-label="Recenter on the current time">
				↺ now
			</button>
		{/if}
		<span class="header-spacer" aria-hidden="true"></span>
		<span class="wide-only date-span">
			{dateSpanLabel}
			<span class="utc-clock">UTC {fmtClockUtc(time)}</span>
		</span>
		<span class="wide-only">
			{#if cursorDayReadout}
				{@const moon = cursorDayReadout.moon}
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
		</span>
	</div>
	<div class="strip">
		<div
			class="bar"
			class:dragging
			bind:this={barEl}
			onpointerdown={handlePointerDown}
			onpointermove={handlePointerMove}
			onpointerup={handlePointerEnd}
			onpointercancel={handlePointerEnd}
			onkeydown={handleKey}
			role="slider"
			tabindex="0"
			aria-label="Time scrubber"
			aria-orientation={orientation}
			aria-valuemin={0}
			aria-valuemax={1439}
			aria-valuenow={time.getUTCHours() * 60 + time.getUTCMinutes()}
			aria-valuetext={ariaValueText}
		>
			{#if geom && scales}
				<svg class="ribbon" width="100%" height="100%" viewBox="0 0 {boxW} {boxH}" aria-hidden="true">
					<defs>
						<linearGradient id={gradId} x1="0" y1="0" x2={horizontal ? 1 : 0} y2={horizontal ? 0 : 1}>
							{#each stops as stop (stop.offset)}
								<stop offset={stop.offset} stop-color="#ffffff" stop-opacity={stop.opacity} />
							{/each}
						</linearGradient>
						<!-- The Hann envelope is SCREEN-FIXED (the cursor is always the
						     center) — encoded once as a mask; only the pan group moves. -->
						<mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={boxW} height={boxH}>
							<rect x="0" y="0" width={boxW} height={boxH} fill="url(#{gradId})" />
						</mask>
					</defs>
					<g mask="url(#{maskId})">
						<g class="pan" class:recentering style="transform: {panTransform};">
							<!-- Painter's order: far limb first, near (dusk) limb on top. -->
							<g>
								{#each backSegments as s, i (i)}
									<line
										class="stripe"
										data-phase={s.phase}
										x1={s.x1}
										y1={s.y1}
										x2={s.x2}
										y2={s.y2}
										stroke={s.color}
										stroke-width={s.strokeWidth}
										stroke-opacity={s.alpha}
										stroke-linecap="round"
									/>
								{/each}
							</g>
							<g>
								{#each frontSegments as s, i (i)}
									<line
										class="stripe"
										data-phase={s.phase}
										x1={s.x1}
										y1={s.y1}
										x2={s.x2}
										y2={s.y2}
										stroke={s.color}
										stroke-width={s.strokeWidth}
										stroke-opacity={s.alpha}
										stroke-linecap="round"
									/>
								{/each}
							</g>
							{#each noduleViews as nv (nv.id)}
								{#if nv.glow}
									<circle
										cx={nv.x}
										cy={nv.y}
										r={nv.n.radius + 3.5}
										fill="none"
										stroke={nv.n.color}
										stroke-opacity={0.3 * nv.alpha}
										stroke-width="1.5"
									/>
								{/if}
								<circle
									cx={nv.x}
									cy={nv.y}
									r={nv.n.radius}
									fill={nv.n.color}
									fill-opacity={nv.alpha}
									stroke="rgba(6, 8, 13, 0.8)"
									stroke-width="0.75"
								/>
							{/each}
							<!-- Wall-clock now: a thin staff riding the tape at its absolute
							     position (a rect so its bounding box is real for e2e). -->
							{#if horizontal}
								<rect data-now-marker class="now-staff" x={nowAxisPx - 1} y={2} width="2" height={boxH - 4} />
							{:else}
								<rect data-now-marker class="now-staff" x={2} y={nowAxisPx - 1} width={boxW - 4} height="2" />
							{/if}
						</g>
					</g>
					<!-- Screen-fixed center staff = the CURSOR. Bold white-on-amber when
					     it coincides with now; amber when scrubbed apart. -->
					{#if horizontal}
						{#if coincident}
							<line class="center-halo" x1={boxW / 2} y1="0" x2={boxW / 2} y2={boxH} stroke-width="5" />
							<line class="center-staff coincident" x1={boxW / 2} y1="0" x2={boxW / 2} y2={boxH} stroke-width="2" />
							<text class="now-label" x={boxW / 2} y="10" text-anchor="middle">now {fmtClockLocal(now)}</text>
						{:else}
							<line class="center-staff" x1={boxW / 2} y1="0" x2={boxW / 2} y2={boxH} stroke-width="2" />
						{/if}
					{:else if coincident}
						<line class="center-halo" x1="0" y1={boxH / 2} x2={boxW} y2={boxH / 2} stroke-width="5" />
						<line class="center-staff coincident" x1="0" y1={boxH / 2} x2={boxW} y2={boxH / 2} stroke-width="2" />
						<text class="now-label" x={boxW / 2} y="10" text-anchor="middle">now {fmtClockLocal(now)}</text>
					{:else}
						<line class="center-staff" x1="0" y1={boxH / 2} x2={boxW} y2={boxH / 2} stroke-width="2" />
					{/if}
					<!-- Now outside the window: an edge chevron pointing toward it. -->
					{#if nowOffEdge === 1}
						{#if horizontal}
							<path
								class="now-chevron"
								d="M {boxW - 11} {boxH / 2 - 5} L {boxW - 4} {boxH / 2} L {boxW - 11} {boxH / 2 + 5} Z"
							/>
						{:else}
							<path
								class="now-chevron"
								d="M {boxW / 2 - 5} {boxH - 11} L {boxW / 2} {boxH - 4} L {boxW / 2 + 5} {boxH - 11} Z"
							/>
						{/if}
					{:else if nowOffEdge === -1}
						{#if horizontal}
							<path class="now-chevron" d="M 11 {boxH / 2 - 5} L 4 {boxH / 2} L 11 {boxH / 2 + 5} Z" />
						{:else}
							<path class="now-chevron" d="M {boxW / 2 - 5} 11 L {boxW / 2} 4 L {boxW / 2 + 5} 11 Z" />
						{/if}
					{/if}
				</svg>
			{/if}
		</div>
		<!-- Invisible 24×24 hit targets over the nodules, translated with the same
		     pan as the tape. A sibling of the slider (not a child) so the buttons
		     stay real interactive elements in the accessibility tree. -->
		<div class="nodule-layer" style="transform: {panTransform};">
			{#each noduleViews as nv (nv.id)}
				{@const d = new Date(nv.n.tMs)}
				<div class="nodule-hit-wrap" style="left: {nv.x - 12}px; top: {nv.y - 12}px;">
					<Popover
						positioning={{
							placement: 'top',
							strategy: 'fixed',
							overflowPadding: 12,
							flip: true,
							slide: true,
							fitViewport: true,
						}}
					>
						<Popover.Trigger class="nodule-hit" aria-label="{nv.n.tip.long} {fmtClockLocal(d)}"></Popover.Trigger>
						<Popover.Positioner>
							{#snippet element(attributes)}
								<div {...attributes} use:portal>
									<Popover.Content class="help-tooltip-content">
										<div>
											<strong>{nv.n.tip.long}</strong>
											{fmtClockLocal(d)} local · {fmtClockUtc(d)} UTC
											<br />
											{nv.n.tip.description}
										</div>
									</Popover.Content>
								</div>
							{/snippet}
						</Popover.Positioner>
					</Popover>
				</div>
			{/each}
		</div>
	</div>
</div>

<style>
	.gantt {
		position: fixed;
		left: 1rem;
		/* Leave room for the MapToolbar's column on the right. */
		right: var(--map-toolbar-inset-rem, 5rem);
		bottom: calc(var(--gantt-bottom-rem, 0.75rem) + env(safe-area-inset-bottom, 0px));
		background: rgba(8, 10, 16, 0.92);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 6px;
		padding: 0.45rem 0.75rem 0.55rem;
		color: #e9ecf3;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.7rem;
		z-index: 6;
		pointer-events: auto;
		/* The tape pans under a screen-fixed mask — never let it spill into the
		   document (e2e/overflow.spec gates document-level overflow). No
		   backdrop-filter here on purpose: iOS compositing hazard. */
		overflow: hidden;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
	}
	.header {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 0.3rem;
		font-size: 0.65rem;
		opacity: 0.9;
		min-height: 1.25rem;
	}
	.header-spacer {
		flex: 1 1 auto;
	}
	.clock-chip {
		font-variant-numeric: tabular-nums;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.phase-dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		border: 1px solid rgba(255, 255, 255, 0.35);
		display: inline-block;
		flex: 0 0 auto;
	}
	.recenter-chip {
		font: inherit;
		font-size: 0.6rem;
		font-variant-numeric: tabular-nums;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		background: rgba(var(--accent-amber-rgb), 0.12);
		border: 1px solid rgba(var(--accent-amber-rgb), 0.3);
		color: var(--accent-amber);
		cursor: pointer;
	}
	.recenter-chip:focus-visible {
		outline: 2px solid rgba(127, 187, 255, 0.7);
		outline-offset: 1px;
	}
	.date-span {
		font-variant-numeric: tabular-nums;
		opacity: 0.75;
		white-space: nowrap;
	}
	.utc-clock {
		font-size: 0.58rem;
		opacity: 0.7;
		margin-left: 0.3rem;
	}
	.phase {
		opacity: 0.7;
	}
	.strip {
		position: relative;
		height: 78px;
		overflow: hidden;
	}
	.bar {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		border-radius: 4px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(10, 13, 22, 0.55);
		cursor: grab;
		touch-action: pan-y;
		outline: none;
	}
	.bar.dragging {
		cursor: grabbing;
	}
	.bar:focus-visible {
		box-shadow: 0 0 0 2px rgba(127, 187, 255, 0.5);
	}
	.ribbon {
		display: block;
		width: 100%;
		height: 100%;
		/* The phase palette IS the data — keep it under forced colors. The
		   header chips above take system colors as usual. */
		forced-color-adjust: none;
	}
	.pan {
		will-change: transform;
	}
	.pan.recentering {
		transition: transform 280ms ease;
	}
	@media (prefers-reduced-motion: reduce) {
		.pan.recentering {
			transition: none;
		}
	}
	.now-staff {
		fill: rgba(255, 255, 255, 0.8);
	}
	.center-staff {
		stroke: var(--accent-amber);
	}
	.center-staff.coincident {
		stroke: #ffffff;
	}
	.center-halo {
		stroke: var(--accent-amber);
		stroke-opacity: 0.4;
	}
	.now-label {
		fill: rgba(255, 255, 255, 0.85);
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.55rem;
	}
	.now-chevron {
		fill: var(--accent-amber);
	}
	.nodule-layer {
		position: absolute;
		inset: 0;
		pointer-events: none;
		forced-color-adjust: none;
	}
	.nodule-hit-wrap {
		position: absolute;
		width: 24px;
		height: 24px;
		pointer-events: auto;
	}
	:global(.time-helix .nodule-hit) {
		display: block;
		width: 24px;
		height: 24px;
		padding: 0;
		background: none;
		border: none;
		border-radius: 50%;
		cursor: pointer;
	}
	:global(.time-helix .nodule-hit:focus-visible) {
		outline: 2px solid rgba(127, 187, 255, 0.7);
		outline-offset: -2px;
	}
	/* Mirrors the gantt's W4b media override: below 640px (or short screens)
	   the strip compacts and the WIDE-only chips (date span + moon) drop —
	   COMPACT keeps exactly one clock chip plus the ↺ now chip when scrubbed. */
	@media (max-width: 639.98px), (max-height: 500px) {
		.gantt {
			left: 0.75rem;
			right: var(--map-toolbar-inset-rem, 5rem);
			padding: 0.4rem 0.65rem 0.45rem;
		}
		.header {
			gap: 0.35rem 0.6rem;
		}
		.strip {
			height: 60px;
		}
		.wide-only {
			display: none;
		}
	}
</style>
