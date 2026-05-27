<script lang="ts">
	import { X } from '@lucide/svelte';

	/**
	 * MapErrorToast — surfaces transient MapLibre / fetch failures so the
	 * user sees something when a tile or featureinfo call fails, instead
	 * of staring at a blank layer.
	 *
	 * Parent feeds errors via the `errors` prop; the most recent N (default
	 * 3) are shown in a stack at the bottom-left, auto-dismissing after
	 * `autoDismissMs`. Each entry has its own dismiss × button too.
	 *
	 * The toast is purely a UI surface — it does NOT subscribe to anything.
	 * The route hooks MapLibre's `'error'` event and dispatches into here.
	 */

	import { onDestroy } from 'svelte';

	export interface ToastErr {
		readonly id: number;
		readonly text: string;
		readonly source?: string;
	}

	interface Props {
		errors: readonly ToastErr[];
		autoDismissMs?: number;
		onDismiss: (id: number) => void;
	}

	let { errors, autoDismissMs = 6000, onDismiss }: Props = $props();

	// Track which ids we've already armed the auto-dismiss timer for so we
	// don't double-schedule when the parent re-renders. The map is not
	// reactive state — it's a setTimeout-handle bookkeeper.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, not stored in state
	const timers = new Map<number, ReturnType<typeof setTimeout>>();
	$effect(() => {
		for (const e of errors) {
			if (timers.has(e.id)) continue;
			timers.set(
				e.id,
				setTimeout(() => {
					timers.delete(e.id);
					onDismiss(e.id);
				}, autoDismissMs),
			);
		}
		// Clean up timers for ids the parent has already removed.
		const liveIds = new Set(errors.map((e) => e.id));
		for (const [id, t] of timers) {
			if (!liveIds.has(id)) {
				clearTimeout(t);
				timers.delete(id);
			}
		}
	});

	onDestroy(() => {
		for (const t of timers.values()) clearTimeout(t);
		timers.clear();
	});
</script>

{#if errors.length > 0}
	<aside class="toasts" aria-live="polite" aria-label="Map error notifications">
		{#each errors as e (e.id)}
			<div class="toast" role="alert">
				<span class="msg">
					{#if e.source}
						<span class="src">{e.source}:</span>
					{/if}
					{e.text}
				</span>
				<button type="button" class="dismiss" aria-label="Dismiss error" onclick={() => onDismiss(e.id)}>
					<X size={14} aria-hidden="true" />
				</button>
			</div>
		{/each}
	</aside>
{/if}

<style>
	.toasts {
		position: fixed;
		left: 1rem;
		bottom: 1rem;
		display: flex;
		flex-direction: column-reverse;
		gap: 0.4rem;
		max-width: min(22rem, calc(100vw - 8rem));
		z-index: 8;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.72rem;
		pointer-events: none;
	}
	.toast {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		background: rgba(120, 30, 30, 0.88);
		color: #ffe6e6;
		border: 1px solid rgba(255, 120, 120, 0.45);
		border-radius: 6px;
		padding: 0.45rem 0.65rem;
		pointer-events: auto;
		backdrop-filter: blur(6px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
	}
	.src {
		opacity: 0.7;
		margin-right: 0.25rem;
	}
	.msg {
		flex: 1 1 auto;
		word-break: break-word;
	}
	.dismiss {
		flex: 0 0 auto;
		background: transparent;
		color: inherit;
		border: none;
		padding: 0 0.25rem;
		font: inherit;
		cursor: pointer;
		opacity: 0.7;
	}
	.dismiss:hover {
		opacity: 1;
	}
</style>
