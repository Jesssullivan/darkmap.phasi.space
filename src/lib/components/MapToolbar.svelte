<script lang="ts">
	/**
	 * MapToolbar — vertical stack of map-overlay toggles in the
	 * bottom-right corner. Replaces the two standalone time / sun-moon
	 * buttons that fought the EphemerisGantt + TimeDock for the same space.
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
		readonly label: string; // for screen readers
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

<aside class="toolbar" aria-label="Map overlay toggles">
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
		</button>
	{/each}
</aside>

<style>
	.toolbar {
		position: fixed;
		right: 0.75rem;
		bottom: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		z-index: 8;
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.tool {
		background: rgba(8, 10, 16, 0.85);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 999px;
		padding: 0.4rem 0.7rem;
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
		backdrop-filter: blur(6px);
		min-width: 2.5rem;
		min-height: 2.5rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.tool:hover {
		border-color: rgba(255, 209, 102, 0.65);
		color: #ffd166;
	}
	.tool[aria-pressed='true'] {
		color: #ffd166;
		border-color: rgba(255, 209, 102, 0.65);
	}
	.tool:focus-visible {
		outline: 2px solid #ffd166;
		outline-offset: 2px;
	}
	@media (pointer: coarse) {
		.tool {
			min-width: 3rem;
			min-height: 3rem;
			padding: 0.45rem 0.75rem;
		}
	}
</style>
