<script lang="ts">
	/**
	 * HelpTooltip — convenience wrapper around Skeleton 4.15.2's
	 * Zag-backed Popover primitive for our map-overlay readouts.
	 *
	 * Was built on `Tooltip` originally, but the Zag tooltip machine is
	 * hover/focus driven and dismisses on `pointerdown`, so a touch tap
	 * on the trigger opens and immediately re-closes the panel. Mobile
	 * users could not read the help text. Migrated to `Popover`, whose
	 * Zag machine is click/tap driven with `closeOnInteractOutside` +
	 * `closeOnEscape`, exactly matching the "touch-friendly Skeleton
	 * popover" promise in issue #197.
	 *
	 * Public API is unchanged: callers still pass `text` or a `content`
	 * snippet plus a `trigger` snippet. The component name is kept for
	 * call-site stability — renaming the wrapper would churn dozens of
	 * imports across the map UI for zero behavior delta.
	 */

	import { Popover } from '@skeletonlabs/skeleton-svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		text?: string;
		positioning?: 'top' | 'bottom' | 'left' | 'right';
		trigger: Snippet;
		content?: Snippet;
	}

	let { text, positioning = 'top', trigger, content }: Props = $props();
</script>

<Popover positioning={{ placement: positioning }}>
	<Popover.Trigger class="help-tooltip-trigger" aria-label="Show help">
		{@render trigger()}
	</Popover.Trigger>
	<Popover.Positioner>
		<Popover.Content class="help-tooltip-content">
			{#if content}
				{@render content()}
			{:else if text}
				{text}
			{/if}
		</Popover.Content>
	</Popover.Positioner>
</Popover>

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
		/* Click/tap-activated now, so a pointer cursor is the correct hint. */
		cursor: pointer;
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
