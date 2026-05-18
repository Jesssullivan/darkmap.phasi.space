<script lang="ts">
	/**
	 * HelpTooltip — convenience wrapper around Skeleton 4.15.2's
	 * Zag-backed Tooltip primitive for our map-overlay readouts.
	 *
	 * Lets a chip render rich, screen-reader-friendly help on hover or
	 * focus without each consumer wiring `Tooltip` /
	 * `Tooltip.Trigger` / `Tooltip.Positioner` / `Tooltip.Content`
	 * by hand. The trigger slot is the visible chip; the content slot
	 * (or `text` prop for one-liners) shows in the floating panel.
	 *
	 * For rich help (formula, links, multi-line) use the `content`
	 * snippet. For a single string, set `text="…"` instead.
	 */

	import { Tooltip } from '@skeletonlabs/skeleton-svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		text?: string;
		positioning?: 'top' | 'bottom' | 'left' | 'right';
		trigger: Snippet;
		content?: Snippet;
	}

	let { text, positioning = 'top', trigger, content }: Props = $props();
</script>

<Tooltip positioning={{ placement: positioning }} openDelay={200} closeDelay={120}>
	<Tooltip.Trigger class="help-tooltip-trigger">
		{@render trigger()}
	</Tooltip.Trigger>
	<Tooltip.Positioner>
		<Tooltip.Content class="help-tooltip-content">
			{#if content}
				{@render content()}
			{:else if text}
				{text}
			{/if}
		</Tooltip.Content>
	</Tooltip.Positioner>
</Tooltip>

<style>
	:global(.help-tooltip-trigger) {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		background: none;
		border: none;
		color: inherit;
		font: inherit;
		padding: 0;
		cursor: help;
	}
	:global(.help-tooltip-content) {
		background: rgba(8, 10, 16, 0.95);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 6px;
		padding: 0.55rem 0.75rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.7rem;
		line-height: 1.4;
		max-width: 22rem;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
		backdrop-filter: blur(6px);
		z-index: 50;
	}
	:global(.help-tooltip-content a) {
		color: #ffd166;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	:global(.help-tooltip-content code) {
		background: rgba(255, 255, 255, 0.06);
		padding: 0.05em 0.3em;
		border-radius: 3px;
	}
</style>
