<script lang="ts">
	/**
	 * MapToolbar — vertical stack of map-overlay toggles in the
	 * bottom-right corner. Replaces the two standalone time / sun-moon
	 * buttons that fought the twilight strip (now TimeHelix) + TimeDock for
	 * the same space.
	 *
	 * The toolbar publishes its width via the `--toolbar-w-rem` CSS
	 * custom property on `:host`. The gantt + dock read that variable
	 * and inset their `right` so they never overlap the toolbar.
	 *
	 * Items pass a Lucide icon Svelte component, not a glyph string —
	 * see #136 (emoji → Lucide swap).
	 */

	import type { Component } from 'svelte';

	interface Item {
		readonly id: string;
		/** Full descriptive name — the accessible name (aria-label) + tooltip. */
		readonly label: string;
		/**
		 * Short visible label rendered beside the icon (e.g. "Twilight").
		 * Distinct from `label` so the tool glyphs are readable without a
		 * hover tooltip (the icon-only a11y gap, §11.4) while keeping the
		 * pills compact. `aria-label` stays the full `label`.
		 */
		readonly shortLabel: string;
		readonly icon: Component;
		readonly title: string;
		readonly pressed: boolean;
		readonly onclick: () => void;
	}

	interface Props {
		items: readonly Item[];
	}

	let { items }: Props = $props();
</script>

<aside class="toolbar" aria-label="Map overlay toggles" data-tour="toolbar">
	{#each items as it (it.id)}
		{@const Icon = it.icon}
		<button
			type="button"
			class="tool"
			aria-label={it.label}
			aria-pressed={it.pressed}
			title={it.title}
			onclick={it.onclick}
		>
			<Icon size={18} aria-hidden="true" />
			<span class="tool-label">{it.shortLabel}</span>
		</button>
	{/each}
</aside>

<style>
	.toolbar {
		position: fixed;
		/* Clear the notch / home indicator in landscape on notched devices. */
		right: max(0.75rem, env(safe-area-inset-right));
		bottom: max(0.75rem, env(safe-area-inset-bottom));
		display: flex;
		flex-direction: column;
		/* Size to the widest labeled pill so align-items:stretch gives every
		   button enough width for its icon + label (without this the fixed
		   column can shrink-to-fit at ~icon width and the labels collapse). */
		width: max-content;
		align-items: stretch;
		gap: 0.5rem;
		z-index: 8;
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.tool {
		background: rgba(8, 10, 16, 0.85);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 999px;
		padding: 0.4rem 0.85rem;
		font: inherit;
		font-size: 0.85rem;
		line-height: 1;
		cursor: pointer;
		backdrop-filter: blur(6px);
		min-width: 2.5rem;
		min-height: 2.5rem;
		/* Icon + label row; the column stretches every pill to the widest so
		   the labels left-align into a tidy strip. */
		display: inline-flex;
		align-items: center;
		justify-content: flex-start;
		gap: 0.45rem;
		white-space: nowrap;
	}
	.tool-label {
		font-size: 0.8rem;
		/* Never let the label shrink to 0 in the flex row. */
		flex: 0 0 auto;
	}
	.tool:hover {
		border-color: rgba(var(--accent-amber-rgb), 0.65);
		color: var(--accent-amber);
	}
	.tool[aria-pressed='true'] {
		color: var(--accent-amber);
		border-color: rgba(var(--accent-amber-rgb), 0.65);
	}
	.tool:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 2px;
	}
	@media (pointer: coarse) {
		.tool {
			min-width: 3rem;
			min-height: 3rem;
		}
	}
	/* ≤820px: compact icon-only (today's footprint) so the bottom-right strip
	   never widens into the gantt / readout (--map-toolbar-inset-rem stays 5rem
	   here). aria-label + title keep every tool named without a hover tooltip
	   on touch; the visible labels return on the wider desktop pointer. */
	@media (max-width: 820px) {
		.tool {
			justify-content: center;
			gap: 0;
			padding: 0.45rem 0.75rem;
		}
		.tool-label {
			display: none;
		}
	}
</style>
