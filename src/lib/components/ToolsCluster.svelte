<script lang="ts">
	import type { Lens } from '$lib/lens';
	import { Radio, Satellite, Wind, SunMoon } from '@lucide/svelte';

	/** A deep-tool launcher this cluster can open. */
	export type ToolId = 'transmission' | 'passplan' | 'aq' | 'twilight';

	interface Props {
		/** Active persona lens — re-weights ORDER + accent only (never dims/disables). */
		lens: Lens;
		/** Whether a map point is pinned — drives the carry-the-query affordance hint. */
		hasPoint: boolean;
		/** Twilight strip (DOCK gantt) open state — the Twilight tile reflects it. */
		ephemerisOpen: boolean;
		/** Launch the chosen tool (the page wires this to the open*ForPoint handlers). */
		onlaunch: (tool: ToolId) => void;
		/** 'rail' = labelled tiles in the rail; 'overlay' = compact pills on the map's
		 * right-edge corner (idea ①). Same TOOLS + lens order/accent in both. */
		variant?: 'rail' | 'overlay';
	}

	let { lens, hasPoint, ephemerisOpen, onlaunch, variant = 'rail' }: Props = $props();

	// The four deep tools, each as an ALWAYS-PRESENT, full-opacity launcher. `lens`
	// is the persona this tool leads for — used ONLY to sort it first + accent it
	// when that lens is active. Every tile stays opacity:1 + clickable in every lens
	// (command-deck.md §4 — promote by order/accent, never dim/disable/hide).
	const TOOLS: { id: ToolId; label: string; sub: string; icon: typeof Radio; lens: Lens }[] = [
		{ id: 'transmission', label: 'Transmission', sub: 'T(λ) · path-AOD · link budget', icon: Radio, lens: 'links' },
		{ id: 'passplan', label: 'Pass Plan', sub: 'satellite passes · polar track', icon: Satellite, lens: 'orbit' },
		{ id: 'aq', label: 'Air Quality', sub: 'pollutants · NowCast AQI', icon: Wind, lens: 'air' },
		{ id: 'twilight', label: 'Twilight', sub: 'sun/moon timing · dark window', icon: SunMoon, lens: 'sky' },
	];

	// Flex order: the active lens's tool floats to the top (-1); the rest hold their
	// declared order at full strength. No reordering of the others, no dimming.
	const orderFor = (toolLens: Lens): number => (toolLens === lens ? -1 : 0);
</script>

<section class="tools-cluster" class:overlay={variant === 'overlay'} aria-label="Deep tools">
	{#if variant === 'rail'}<h2 class="cluster-title">Tools</h2>{/if}
	<div class="cluster-grid">
		{#each TOOLS as t (t.id)}
			{@const Icon = t.icon}
			{@const lead = t.lens === lens}
			<button
				type="button"
				class="tool-tile"
				class:lead
				style:order={orderFor(t.lens)}
				aria-label={`Open ${t.label}${lead ? ' — leads the active lens' : ''}`}
				onclick={() => onlaunch(t.id)}
			>
				<span class="tool-icon"><Icon size={16} aria-hidden="true" /></span>
				<span class="tool-text">
					<span class="tool-label">
						{t.label}
						{#if t.id === 'twilight' && ephemerisOpen}<span class="on-dot" aria-label="open" title="open"></span>{/if}
					</span>
					{#if variant === 'rail'}<span class="tool-sub">{t.sub}</span>{/if}
				</span>
				{#if variant === 'rail'}<span class="tool-go" aria-hidden="true"
						>{hasPoint || t.id === 'twilight' ? 'Open' : 'Pin →'}</span
					>{/if}
			</button>
		{/each}
	</div>
</section>

<style>
	/* Pinned to the bottom of the RAIL (.left-dock). The persistent Level-1 launcher
	   cluster (command-deck.md §2): all four deep tools are always one click away. */
	.tools-cluster {
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		padding-top: 0.5rem;
		margin-top: 0.25rem;
		border-top: 1px solid rgba(255, 255, 255, 0.1);
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.cluster-title {
		font-size: 0.58rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		opacity: 0.55;
		margin: 0 0 0.1rem;
		color: #e9ecf3;
	}
	.cluster-grid {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.tool-tile {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-width: 0;
		text-align: left;
		padding: 0.4rem 0.5rem;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 7px;
		background: rgba(8, 10, 16, 0.55);
		color: #e9ecf3;
		font: inherit;
		cursor: pointer;
		transition:
			border-color 140ms ease,
			background 140ms ease;
	}
	.tool-tile:hover,
	.tool-tile:focus-visible {
		border-color: rgba(255, 255, 255, 0.3);
		background: rgba(255, 255, 255, 0.06);
		outline: none;
	}
	.tool-tile:focus-visible {
		outline: 2px solid var(--lens-accent, var(--accent-amber));
		outline-offset: 1px;
	}
	/* LEAD = the active lens's tool. Carries the active lens accent (W5c) + slightly
	   heavier — never at the expense of the others' legibility (they stay opacity:1,
	   full contrast). */
	.tool-tile.lead {
		border-color: rgba(var(--lens-accent-rgb, var(--accent-amber-rgb)), 0.6);
		background: rgba(var(--lens-accent-rgb, var(--accent-amber-rgb)), 0.08);
	}
	.tool-icon {
		display: flex;
		flex: 0 0 auto;
		color: var(--lens-accent, var(--accent-amber));
	}
	.tool-tile:not(.lead) .tool-icon {
		color: #aeb6c6;
	}
	.tool-text {
		display: flex;
		flex-direction: column;
		gap: 0.05rem;
		min-width: 0;
		flex: 1 1 auto;
	}
	.tool-label {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.78rem;
		font-weight: 600;
		line-height: 1.1;
	}
	.tool-tile.lead .tool-label {
		color: var(--lens-accent, var(--accent-amber));
	}
	.tool-sub {
		font-size: 0.6rem;
		opacity: 0.6;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tool-go {
		flex: 0 0 auto;
		font-size: 0.6rem;
		opacity: 0.55;
		letter-spacing: 0.04em;
	}
	.on-dot {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 50%;
		background: var(--lens-accent, var(--accent-amber));
		box-shadow: 0 0 4px var(--lens-accent, var(--accent-amber));
	}

	/* OVERLAY variant (idea ①) — compact rounded pills hugging the map's right edge.
	   +page positions the cluster absolute in the stage cell; these pills echo the
	   top-left MapToolbar's pill vocabulary so both stage corners speak one control
	   language. Pulling the cluster out of the rail frees the LayerRail's full height. */
	.tools-cluster.overlay {
		border-top: 0;
		padding-top: 0;
		margin-top: 0;
		gap: 0.4rem;
	}
	.tools-cluster.overlay .cluster-grid {
		gap: 0.4rem;
	}
	.tools-cluster.overlay .tool-tile {
		width: auto;
		min-height: 2.5rem;
		gap: 0.45rem;
		padding: 0.4rem 0.7rem;
		border-radius: 999px;
		background: rgba(8, 10, 16, 0.85);
		backdrop-filter: blur(6px);
		border-color: rgba(255, 255, 255, 0.14);
	}
	.tools-cluster.overlay .tool-label {
		font-size: 0.72rem;
		white-space: nowrap;
	}
	.tools-cluster.overlay .tool-tile.lead {
		border-color: rgba(var(--lens-accent-rgb, var(--accent-amber-rgb)), 0.7);
		background: rgba(var(--lens-accent-rgb, var(--accent-amber-rgb)), 0.12);
	}
	@media (pointer: coarse) {
		.tools-cluster.overlay .tool-tile {
			min-height: 3rem;
		}
	}
</style>
