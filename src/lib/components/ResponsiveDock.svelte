<script lang="ts" module>
	import type { Snippet } from 'svelte';

	/** The ONE bottom-sheet's swap views (content-SWAP, never a 2nd panel). */
	export type DockView = 'layers' | 'readout' | 'tools';
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { Layers, MapPin, Sliders } from '@lucide/svelte';

	interface Props {
		/** The active swap view. Drives which content the ONE sheet shows. */
		view: DockView;
		/** Switch the sheet's content (NEVER spawns a 2nd panel). */
		onViewChange: (next: DockView) => void;
		/** Open the layers drawer (the rail's tall layers list — the Layers view). */
		onOpenLayers: () => void;
		/** True when a point is pinned (badges the Readout tab + its accessible name). */
		hasPoint: boolean;
		/** True when a deep tool (transmission / pass-plan) is open (badges Tools). */
		toolsActive: boolean;
		/** The thin twilight-gantt row — ALWAYS present above the sheet peek. */
		ganttRow?: Snippet;
		/** The Readout view content (the PointReadout). */
		readoutView: Snippet;
		/** The Tools view content (the deep-tool sheets). */
		toolsView: Snippet;
	}

	let { view, onViewChange, onOpenLayers, hasPoint, toolsActive, ganttRow, readoutView, toolsView }: Props = $props();

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

	// The segmented control. Tapping a segment swaps the ONE sheet's content; the
	// Layers segment additionally opens the (tall) rail drawer — its own height≥500
	// detent — so the layers list never crams into a HALF sheet. All three segments
	// stay full-opacity + reachable in every state (progressive disclosure, never
	// disabled). aria-pressed marks the active view for assistive tech. A Readout /
	// Tools tap also raises the sheet so the swapped-in content is on-screen.
	function pick(next: DockView): void {
		if (next === 'layers') onOpenLayers();
		else void tick().then(raiseSoon);
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
			<!-- Grab handle — the drag affordance + the visual peek cap. -->
			<div class="dock-grip" aria-hidden="true"></div>

			<!-- The twilight gantt: its OWN thin row, always present above everything
			     else in the sheet, at every detent. -->
			{#if ganttRow}
				<div class="dock-gantt-row">{@render ganttRow()}</div>
			{/if}

			<!-- The segmented swap control: full-opacity, always reachable. -->
			<div class="dock-tabs" role="group" aria-label="Dock view">
				<button
					type="button"
					class="dock-tab"
					class:active={view === 'layers'}
					aria-pressed={view === 'layers'}
					aria-label="Show layers"
					onclick={() => pick('layers')}
				>
					<Layers size={16} aria-hidden="true" />
					<span>Layers</span>
				</button>
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
		padding: 0.4rem 0.75rem calc(0.75rem + env(safe-area-inset-bottom, 0px));
		padding-left: max(0.75rem, env(safe-area-inset-left, 0px));
		padding-right: max(0.75rem, env(safe-area-inset-right, 0px));
	}

	.dock-grip {
		flex: 0 0 auto;
		width: 2.5rem;
		height: 0.25rem;
		margin: 0.15rem auto 0.35rem;
		border-radius: 999px;
		background: rgba(233, 236, 243, 0.32);
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

	/* The segmented swap control — full-opacity, always reachable, never disabled. */
	.dock-tabs {
		flex: 0 0 auto;
		display: grid;
		grid-template-columns: repeat(3, 1fr);
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
