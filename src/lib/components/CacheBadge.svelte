<script lang="ts">
	/**
	 * CacheBadge — small Skeleton-styled pill that surfaces cache/freshness
	 * state on any overlay readout (#233, child of #195).
	 *
	 * Pure rendering: state derivation lives in `$lib/cache/badge.ts`;
	 * this component just composes a `HelpTooltip` trigger with the
	 * appropriate tone class. The pill class names and color palette
	 * mirror the inline `.cache-pill` in `EphemerisGantt.svelte` so the
	 * twilight rail can adopt this component without a visual delta.
	 *
	 * Mobile users tap the pill to see the detail string; desktop users
	 * click. (HelpTooltip is now Popover-backed — see #229.)
	 */

	import HelpTooltip from '$lib/components/HelpTooltip.svelte';
	import { buildCacheBadge, type CacheBadgeKind } from '$lib/cache/badge';

	interface Props {
		readonly online: boolean;
		readonly kind: CacheBadgeKind;
		readonly storedAtMs?: number;
		readonly now?: number;
	}

	let { online, kind, storedAtMs, now }: Props = $props();

	const view = $derived(buildCacheBadge({ online, kind, storedAtMs }, now ?? Date.now()));
</script>

<HelpTooltip text={view.detail}>
	{#snippet trigger()}
		<span
			class="cache-pill"
			class:cached={view.tone === 'cached'}
			class:empty={view.tone === 'empty'}
			class:error={view.tone === 'error'}
			class:live={view.tone === 'live'}
			class:loading={view.tone === 'loading'}
			class:stale={view.tone === 'stale'}
			aria-label="Cache state: {view.label}">{view.label}</span
		>
	{/snippet}
</HelpTooltip>

<style>
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
		font-family: var(--font-mono, ui-monospace, monospace);
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
	.cache-pill.empty {
		border-color: rgba(160, 160, 170, 0.4);
		background: rgba(160, 160, 170, 0.1);
		color: rgba(220, 220, 230, 0.75);
	}
</style>
