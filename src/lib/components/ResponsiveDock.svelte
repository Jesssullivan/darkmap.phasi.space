<script lang="ts" module>
	import type { Snippet } from 'svelte';

	/** The ONE bottom-sheet's swap views (content-SWAP, never a 2nd panel). */
	export type DockView = 'readout' | 'tools';
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { MapPin, Sliders } from '@lucide/svelte';
	import { diagnostics } from '$lib/diagnostics.svelte';

	interface Props {
		/** The active swap view. Drives which content the ONE sheet shows. */
		view: DockView;
		/** Switch the sheet's content (NEVER spawns a 2nd panel). */
		onViewChange: (next: DockView) => void;
		/** True when a point is pinned (badges the Readout tab + its accessible name). */
		hasPoint: boolean;
		/** True when a deep tool (transmission / pass-plan) is open (badges Tools). */
		toolsActive: boolean;
		/** The thin twilight-gantt row — ALWAYS present above the sheet peek. */
		ganttRow?: Snippet;
		/** The lens-switcher strip (P6) — the 4-segment lens picker, docked here on the
		 * smallest screens instead of floating over the map. Sits above the gantt row. */
		lensStrip?: Snippet;
		/** The Readout view content (the PointReadout). */
		readoutView: Snippet;
		/** The Tools view content (the deep-tool sheets). */
		toolsView: Snippet;
	}

	let { view, onViewChange, hasPoint, toolsActive, ganttRow, lensStrip, readoutView, toolsView }: Props = $props();

	// The scroll-snap rail + the HALF detent target, for the auto-raise below.
	let railEl = $state<HTMLDivElement | undefined>();
	let halfSnapEl = $state<HTMLDivElement | undefined>();

	// Raise the sheet from PEEK to (at least) HALF so freshly-shown content (a pinned
	// point's readout, an opened tool) is on-screen without a manual drag. Pure
	// scroll-snap: move the rail's scrollTop to the HALF snap target; the browser
	// settles on the nearest snap. Only ever raises (never pulls FULL back down to
	// HALF). Uses instant scroll — async readout content reflows the snap track, and
	// a smooth animation gets interrupted mid-flight by that reflow. The user can
	// drag to PEEK / FULL afterwards. A double-rAF + a late retry catch the
	// post-load reflow so the rest lands on HALF, not part-way.
	function raiseToHalf(): void {
		const rail = railEl;
		const half = halfSnapEl;
		if (!rail || !half) return;
		const target = half.offsetTop;
		if (rail.scrollTop < target - 1) rail.scrollTop = target;
	}
	function raiseSoon(): void {
		requestAnimationFrame(() => {
			raiseToHalf();
			requestAnimationFrame(raiseToHalf);
		});
		// The readout fetch lands a beat later and reflows the snap track; re-pin HALF.
		setTimeout(raiseToHalf, 350);
	}

	// Auto-raise when content first appears (a point pins → Readout; a tool opens →
	// Tools). Tracking hasPoint/toolsActive registers the deps; a no-content state
	// leaves the resting detent untouched (PEEK).
	let lastHasContent = false;
	$effect(() => {
		const hasContent = hasPoint || toolsActive;
		if (hasContent && !lastHasContent) {
			void tick().then(raiseSoon);
		}
		lastHasContent = hasContent;
	});

	// iOS URL-bar show/hide resizes the VISUAL viewport but does NOT re-run scroll-snap
	// (WebKit gap — Chrome 81+ re-snaps after a layout change, Safari/iOS/FF do not), so
	// the rail's scrollTop becomes a stale pixel offset against the resized dvh track and
	// the sheet strands mid-detent. Re-pin to the NEAREST detent on visualViewport RESIZE
	// (resize only — `scroll` fires continuously during rubber-band and would fight a
	// drag), preserving the user's chosen detent. Dormant without a real resize event
	// (so inert on desktop); the +layout.svelte bridge publishes the metrics it tracks.
	$effect(() => {
		const rail = railEl;
		const vv = typeof window !== 'undefined' ? (window.visualViewport ?? null) : null;
		if (!rail || !vv) return;
		let raf1 = 0;
		let raf2 = 0;
		const resettle = (): void => {
			const maxTop = rail.scrollHeight - rail.clientHeight;
			const halfTop = halfSnapEl ? halfSnapEl.offsetTop : maxTop * 0.4;
			const top = rail.scrollTop;
			const edges = [0, halfTop, maxTop]; // PEEK / HALF / FULL
			const nearest = edges.reduce((a, b) => (Math.abs(b - top) < Math.abs(a - top) ? b : a));
			// Diagnostics (no-op unless ?diag=1): the load-bearing capture — does the
			// programmatic re-pin write below actually move scrollTop on WebKit?
			diagnostics.record('resettle-pre', {
				scrollTop: Math.round(top),
				maxTop: Math.round(maxTop),
				halfTop: Math.round(halfTop),
				nearest: Math.round(nearest),
			});
			// Double-rAF: let the resized track settle before re-pinning (raiseSoon's idiom).
			cancelAnimationFrame(raf1);
			cancelAnimationFrame(raf2);
			raf1 = requestAnimationFrame(() => {
				rail.scrollTop = nearest;
				raf2 = requestAnimationFrame(() => {
					rail.scrollTop = nearest;
					diagnostics.record('resettle-post', {
						wrote: Math.round(nearest),
						got: Math.round(rail.scrollTop),
						honored: Math.abs(rail.scrollTop - nearest) < 2,
					});
				});
			});
		};
		vv.addEventListener('resize', resettle);
		return () => {
			vv.removeEventListener('resize', resettle);
			cancelAnimationFrame(raf1);
			cancelAnimationFrame(raf2);
		};
	});

	// ── grip drag (Bug A) ─────────────────────────────────────────────────────
	// The grip was a decorative aria-hidden div — it LOOKED like a drag handle but
	// had no handler, so the only way to move the sheet was scroll-CHAINING into the
	// pointer-events:none rail, which WebKit handles differently (the reported
	// "grip provably nonfunctional" on iOS Safari/Chrome + desktop Safari). Make it
	// a real control: a pointer drag drives rail.scrollTop 1:1 — the one primitive
	// BOTH engines honor (proven in e2e dock-webkit A2) — release snaps to a detent
	// with direction bias, and ArrowUp/Down step detents (the grip is now a
	// focusable button, strictly better a11y than the hidden div). Mandatory
	// scroll-snap is suspended during the drag so it doesn't fight the finger.
	let dragging = $state(false);
	let dragStartY = 0;
	let dragStartTop = 0;

	const detentEdges = (rail: HTMLDivElement): number[] => {
		const maxTop = rail.scrollHeight - rail.clientHeight;
		const halfTop = halfSnapEl ? halfSnapEl.offsetTop : maxTop * 0.4;
		return [0, halfTop, maxTop]; // PEEK / HALF / FULL
	};

	function onGripPointerDown(ev: PointerEvent): void {
		const rail = railEl;
		if (!rail) return;
		dragging = true;
		dragStartY = ev.clientY;
		dragStartTop = rail.scrollTop;
		rail.style.scrollSnapType = 'none';
		// Capture so moves outside the pill keep driving the drag. Guarded: capture can
		// throw (InvalidPointerId) for already-released or synthetic pointers — the drag
		// still works while the pointer stays over the (generous ::after) hit area.
		try {
			(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
		} catch {
			/* non-capturable pointer — proceed uncaptured */
		}
	}
	function onGripPointerMove(ev: PointerEvent): void {
		if (!dragging) return;
		const rail = railEl;
		if (!rail) return;
		// Dragging the grip UP (clientY decreases) raises the sheet → scrollTop grows.
		rail.scrollTop = dragStartTop + (dragStartY - ev.clientY);
	}
	function onGripPointerEnd(ev: PointerEvent): void {
		if (!dragging) return;
		dragging = false;
		try {
			(ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
		} catch {
			/* never captured — fine */
		}
		const rail = railEl;
		if (!rail) return;
		const edges = [...detentEdges(rail)].sort((a, b) => a - b);
		const top = rail.scrollTop;
		const delta = top - dragStartTop;
		// Direction bias: a deliberate drag (>24px) advances to the NEXT detent in the
		// drag direction from the start; a micro-drag settles on the nearest edge.
		let target: number;
		if (Math.abs(delta) > 24) {
			target =
				delta > 0
					? (edges.find((e) => e > dragStartTop + 1) ?? edges[edges.length - 1])
					: ([...edges].reverse().find((e) => e < dragStartTop - 1) ?? edges[0]);
		} else {
			target = edges.reduce((a, b) => (Math.abs(b - top) < Math.abs(a - top) ? b : a));
		}
		diagnostics.record('grip-drag-settle', {
			from: Math.round(dragStartTop),
			at: Math.round(top),
			to: Math.round(target),
		});
		rail.scrollTop = target;
		// Restore mandatory snapping a frame later, after the settle write lands.
		requestAnimationFrame(() => {
			rail.style.scrollSnapType = '';
		});
	}
	function onGripKeydown(ev: KeyboardEvent): void {
		const rail = railEl;
		if (!rail || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
		ev.preventDefault();
		const edges = [...detentEdges(rail)].sort((a, b) => a - b);
		const top = rail.scrollTop;
		rail.scrollTop =
			ev.key === 'ArrowUp'
				? (edges.find((e) => e > top + 1) ?? edges[edges.length - 1])
				: ([...edges].reverse().find((e) => e < top - 1) ?? edges[0]);
	}

	// The segmented control. Tapping a segment swaps the ONE sheet's content; the
	// Layers segment additionally opens the (tall) rail drawer — its own height≥500
	// Both segments stay full-opacity + reachable in every state (progressive
	// disclosure, never disabled). aria-pressed marks the active view for assistive
	// tech. A Readout / Tools tap raises the sheet so the swapped-in content is
	// on-screen. (Layers is NOT a dock segment — the floating "≡ Layers" chip owns
	// the rail drawer, which needs a height≥500 detent the HALF sheet can't give.)
	function pick(next: DockView): void {
		void tick().then(raiseSoon);
		onViewChange(next);
	}
</script>

<!-- W4c (TIN-1866) — the COMPACT (<640px) ResponsiveDock: ONE non-modal bottom-sheet
     with PEEK / HALF / FULL detents (CSS scroll-snap). The map de-fixes into the
     stage behind it (a map strip is ALWAYS visible at the top — FULL ≈ 88vh, never
     100%). A [Layers · Readout · Tools] segmented control SWAPS the single sheet's
     content; switching never spawns a 2nd panel. The twilight gantt is a thin
     always-present row ABOVE the sheet peek at every detent. Marked
     .responsive-dock + data-responsive-dock so W4a's tolerant HUD-overlap assertion
     keys off it. -->
<div class="responsive-dock" data-responsive-dock data-dock-view={view}>
	<!-- The scroll-snap rail: a transparent click-through column of snap targets
	     (PEEK / HALF) above the sheet. Scrolling it slides the sheet up between
	     detents. pointer-events:none on the rail so map pan/click passes through the
	     exposed map strip; the sheet itself re-enables pointer-events. -->
	<div class="dock-rail" bind:this={railEl}>
		<div class="dock-snap dock-snap-peek" aria-hidden="true"></div>
		<div class="dock-snap dock-snap-half" aria-hidden="true" bind:this={halfSnapEl}></div>

		<section class="dock-sheet" aria-label="Map dock">
			<!-- Grab handle — a REAL drag control (Bug A): pointer-drag moves the sheet
			     between detents (rail.scrollTop 1:1, engine-deterministic); ArrowUp/Down
			     step detents for keyboard/AT. -->
			<button
				type="button"
				class="dock-grip"
				class:dragging
				aria-label="Resize dock — drag, or press arrow up / arrow down"
				onpointerdown={onGripPointerDown}
				onpointermove={onGripPointerMove}
				onpointerup={onGripPointerEnd}
				onpointercancel={onGripPointerEnd}
				onkeydown={onGripKeydown}
			></button>

			<!-- P6 — the lens strip, docked here on the smallest screens (it floats over
			     the map at larger tiers). Topmost in the sheet so it's visible at PEEK. -->
			{#if lensStrip}
				<div class="dock-lens-row">{@render lensStrip()}</div>
			{/if}

			<!-- The twilight gantt: its OWN thin row, always present above everything
			     else in the sheet, at every detent. -->
			{#if ganttRow}
				<div class="dock-gantt-row">{@render ganttRow()}</div>
			{/if}

			<!-- The segmented swap control: full-opacity, always reachable. Two segments
			     (Readout · Tools) — both swap the ONE sheet's content. Layers is reached
			     via the floating "≡ Layers" chip (its own tall drawer), not a segment. -->
			<div class="dock-tabs" role="group" aria-label="Dock view">
				<button
					type="button"
					class="dock-tab"
					class:active={view === 'readout'}
					aria-pressed={view === 'readout'}
					aria-label={hasPoint ? 'Show point readout' : 'Show readout'}
					onclick={() => pick('readout')}
				>
					<MapPin size={16} aria-hidden="true" />
					<span>Readout</span>
					{#if hasPoint}<span class="dock-tab-dot" aria-hidden="true"></span>{/if}
				</button>
				<button
					type="button"
					class="dock-tab"
					class:active={view === 'tools'}
					aria-pressed={view === 'tools'}
					aria-label="Show tools"
					onclick={() => pick('tools')}
				>
					<Sliders size={16} aria-hidden="true" />
					<span>Tools</span>
					{#if toolsActive}<span class="dock-tab-dot" aria-hidden="true"></span>{/if}
				</button>
			</div>

			<!-- The ONE swap-content body. The Readout + Tools views are mutually
			     exclusive (the active one renders, the other stays mounted-but-clipped
			     by the parent's view gate). The Layers view content lives in the rail
			     drawer (opened by the Layers segment), so this body carries Readout +
			     Tools only. -->
			<div class="dock-body">
				<div class="dock-pane" data-pane="readout" hidden={view !== 'readout'}>
					{@render readoutView()}
				</div>
				<div class="dock-pane" data-pane="tools" hidden={view !== 'tools'}>
					{@render toolsView()}
				</div>
			</div>
		</section>
	</div>
</div>

<style>
	/* The dock host is a fixed, full-viewport overlay that is CLICK-THROUGH except
	   for the sheet — so the map strip behind it stays pannable. Rendered only at
	   COMPACT (the parent gates it with {#if layoutTier === 'compact'} + the matching
	   media query keeps it inert otherwise). */
	.responsive-dock {
		position: fixed;
		inset: 0;
		z-index: 11;
		pointer-events: none;
	}

	/* The scroll-snap rail spans the viewport. Mandatory y-snapping between the
	   PEEK / HALF / FULL detents (Baseline CSS scroll-snap, zero deps). The rail is
	   click-through; only the sheet re-enables pointer events. overscroll-behavior
	   keeps a sheet-internal scroll from chaining to the document. */
	.dock-rail {
		position: absolute;
		inset: 0;
		overflow-y: scroll;
		overflow-x: hidden;
		scroll-snap-type: y mandatory;
		overscroll-behavior: contain;
		scrollbar-width: none;
		-ms-overflow-style: none;
		pointer-events: none;
		/* Start resting at HALF: the readout/tools content is visible the moment a
		   point pins, without a manual drag (the smoke pins + reads with no scroll). */
		scroll-padding-top: 0;
	}
	.dock-rail::-webkit-scrollbar {
		display: none;
	}

	/* The two transparent snap filler blocks above the sheet set the PEEK + HALF
	   detents (the third, FULL, is the sheet's own end-snap). The geometry, with the
	   sheet pinned bottom (scroll-snap-align:end):
	     • scrollTop 0 → PEEK   : sheet top = peekFiller + halfFiller from the top.
	     • snap to halfFiller   : sheet top = halfFiller height (≈42dvh from top).
	     • scroll to end → FULL : sheet top = 100dvh − sheet height (≈12dvh from top).
	   So halfFiller = the HALF sheet-top (42dvh) and peekFiller = the PEEK→HALF gap
	   (28dvh), giving three DISTINCT, reachable rests: PEEK≈70dvh, HALF≈42dvh,
	   FULL≈12dvh sheet-top. Each filler is the exposed (click-through) map strip. */
	.dock-snap {
		scroll-snap-align: start;
		scroll-snap-stop: always;
		pointer-events: none;
		flex: 0 0 auto;
	}
	/* PEEK→HALF travel: at PEEK the sheet top sits at (peek+half)≈70dvh, peeking the
	   gantt + tabs + a content sliver. */
	.dock-snap-peek {
		height: var(--dock-peek-gap, 28dvh);
	}
	/* HALF: the sheet top rests at ≈42dvh — the body actively scrolls inside. */
	.dock-snap-half {
		height: var(--dock-half-top, 42dvh);
	}

	/* The sheet panel itself. It sits at the bottom of the scroll flow; its top edge
	   slides up as the rail scrolls. FULL height ≈ 88dvh — a map strip ALWAYS shows
	   above it (never 100%). scroll-snap-align:end pins its bottom to the rail's end. */
	.dock-sheet {
		scroll-snap-align: end;
		scroll-snap-stop: always;
		pointer-events: auto;
		display: flex;
		flex-direction: column;
		/* min-height drives the FULL detent — kept ≤ 88dvh so the top map strip lives. */
		min-height: var(--dock-full-h, 88dvh);
		max-height: var(--dock-full-h, 88dvh);
		box-sizing: border-box;
		margin-top: auto;
		background: rgba(8, 10, 16, 0.96);
		border-top: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 14px 14px 0 0;
		box-shadow: 0 -12px 32px rgba(0, 0, 0, 0.5);
		backdrop-filter: blur(10px);
		/* --vv-bottom (the live iOS browser-chrome inset, from the +layout.svelte
		   visualViewport bridge) keeps the sheet's content clear of the URL bar as it
		   slides; 0px on desktop / pre-bridge / no API, so identity there. */
		padding: 0.4rem 0.75rem calc(0.75rem + var(--vv-bottom, 0px) + env(safe-area-inset-bottom, 0px));
		padding-left: max(0.75rem, env(safe-area-inset-left, 0px));
		padding-right: max(0.75rem, env(safe-area-inset-right, 0px));
	}

	.dock-grip {
		flex: 0 0 auto;
		display: block;
		position: relative;
		width: 2.5rem;
		height: 0.25rem;
		margin: 0.15rem auto 0.35rem;
		padding: 0;
		border: 0;
		border-radius: 999px;
		background: rgba(233, 236, 243, 0.32);
		cursor: grab;
		/* The drag owns vertical gestures — keep the browser from hijacking the touch
		   into a page scroll mid-drag. */
		touch-action: none;
	}
	.dock-grip::after {
		/* Invisible expanded hit target (≈44px tall, wider than the pill) WITHOUT
		   growing the sheet header — the header is at 88dvh capacity (the AQ-instrument
		   lesson: any added header height overflows into the gantt/sheet). */
		content: '';
		position: absolute;
		inset: -1.25rem -3rem;
	}
	.dock-grip.dragging {
		cursor: grabbing;
		background: rgba(233, 236, 243, 0.6);
	}
	.dock-grip:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 4px;
	}

	/* The gantt's OWN thin row, pinned above the tabs + body — always present. The
	   EphemerisGantt's COMPACT default is position:fixed at the viewport bottom; here
	   it must flow inside the sheet as a thin row, so de-float it (it keeps its
	   .gantt class + aria-label — only positioning changes). */
	.dock-gantt-row {
		flex: 0 0 auto;
		margin-bottom: 0.4rem;
	}
	.dock-gantt-row :global(.gantt) {
		position: static;
		inset: auto;
		top: auto;
		left: auto;
		right: auto;
		bottom: auto;
		z-index: auto;
		width: 100%;
		box-sizing: border-box;
		backdrop-filter: none;
		box-shadow: none;
	}

	/* P6 — the docked lens strip, above the gantt row. The LensSwitcher's own
	   .docked rules make it a static full-width 4-segment row; this just spaces it. */
	.dock-lens-row {
		flex: 0 0 auto;
		margin-bottom: 0.4rem;
	}

	/* The segmented swap control — full-opacity, always reachable, never disabled. */
	.dock-tabs {
		flex: 0 0 auto;
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.3rem;
		padding: 0.2rem;
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		margin-bottom: 0.5rem;
	}
	.dock-tab {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		padding: 0.45rem 0.3rem;
		min-height: 2.5rem;
		background: transparent;
		color: #e9ecf3;
		border: 1px solid transparent;
		border-radius: 6px;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.78rem;
		letter-spacing: 0.03em;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		/* P6 — meet the 44px touch-target floor on phones (was 2.5rem = 40px). */
		.dock-tab {
			min-height: 2.75rem;
		}
	}
	.dock-tab:hover {
		background: rgba(255, 255, 255, 0.08);
	}
	.dock-tab.active {
		background: rgba(255, 255, 255, 0.14);
		border-color: rgba(var(--accent-amber-rgb), 0.5);
		color: #fff;
	}
	.dock-tab:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 2px;
	}
	.dock-tab-dot {
		position: absolute;
		top: 0.35rem;
		right: 0.45rem;
		width: 0.42rem;
		height: 0.42rem;
		border-radius: 50%;
		background: var(--accent-amber);
	}

	/* The ONE swap-content body. It scrolls internally (at FULL the long readout /
	   tools content is reachable). The hidden pane is the inactive view of the SAME
	   sheet — never a second panel. */
	.dock-body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior: contain;
	}
	.dock-pane[hidden] {
		display: none;
	}

	/* De-float the docked components: the PointReadout (.readout) + the deep-tool
	   sheets (.sheet / .pass-plan) flow inside the sheet body instead of their own
	   COMPACT position:fixed float. They keep their class/role/aria-label (the smoke
	   selectors) — only their positioning changes. */
	.dock-pane :global(.readout),
	.dock-pane :global(.sheet),
	.dock-pane :global(.pass-plan) {
		position: static;
		inset: auto;
		top: auto;
		left: auto;
		right: auto;
		bottom: auto;
		z-index: auto;
		width: 100%;
		min-width: 0;
		max-width: none;
		max-height: none;
		overflow: visible;
		animation: none;
		backdrop-filter: none;
		box-shadow: none;
		border: 0;
		border-radius: 0;
		background: transparent;
		box-sizing: border-box;
	}

	@media (forced-colors: active) {
		.dock-tab.active {
			border-color: Highlight;
		}
	}
</style>
