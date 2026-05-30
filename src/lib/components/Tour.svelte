<script lang="ts" module>
	import type { Snippet } from 'svelte';

	export interface TourStep {
		/** CSS selector for the element to spotlight. If missing/not found, the step centers. */
		readonly anchor?: string;
		readonly title: string;
		readonly body: string;
		/**
		 * Run before measuring the anchor — used to put the app in the right state
		 * (open the mobile drawer, expand a section) so the target exists + is
		 * visible. May be async; the tour waits for it + one frame before measuring.
		 */
		readonly prepare?: () => void | Promise<void>;
	}
</script>

<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { X } from '@lucide/svelte';
	import { portal } from '$lib/actions/portal';

	interface Props {
		steps: readonly TourStep[];
		/** Bindable: drives visibility. */
		open?: boolean;
		/** Called when the tour is finished or skipped. */
		ondone?: () => void;
		/** Optional brand mark shown in the step card header. */
		brand?: Snippet;
	}

	let { steps, open = $bindable(false), ondone, brand }: Props = $props();

	let index = $state(0);
	// Measured rect of the current anchor (viewport coords) — null centers the card.
	let rect = $state<{ top: number; left: number; width: number; height: number } | null>(null);
	let mounted = $state(false);

	const reduceMotion = () => mounted && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	const PAD = 6; // spotlight padding around the target
	const step = $derived(steps[index]);
	const isFirst = $derived(index === 0);
	const isLast = $derived(index === steps.length - 1);

	onMount(() => {
		mounted = true;
	});

	const measure = async (): Promise<void> => {
		const s = steps[index];
		if (!s) return;
		await s.prepare?.();
		await tick();
		// One extra frame so layout/transition settles before we read the rect.
		await new Promise((r) => requestAnimationFrame(() => r(null)));
		const el = s.anchor ? document.querySelector<HTMLElement>(s.anchor) : null;
		if (el) {
			el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
			const r = el.getBoundingClientRect();
			rect = r.width > 0 && r.height > 0 ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
		} else {
			rect = null;
		}
	};

	// Re-measure whenever the step changes or the tour opens.
	$effect(() => {
		if (open) {
			void index; // track
			void measure();
		}
	});

	// Keep the spotlight aligned if the viewport resizes (breakpoint-agnostic).
	$effect(() => {
		if (!open || !mounted) return;
		const onResize = () => void measure();
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	});

	const finish = (): void => {
		open = false;
		index = 0;
		rect = null;
		ondone?.();
	};
	const next = (): void => {
		if (isLast) finish();
		else index += 1;
	};
	const back = (): void => {
		if (!isFirst) index -= 1;
	};

	const onKey = (e: KeyboardEvent): void => {
		if (!open) return;
		if (e.key === 'Escape') finish();
		else if (e.key === 'ArrowRight' || e.key === 'Enter') {
			e.preventDefault();
			next();
		} else if (e.key === 'ArrowLeft') back();
	};

	// Card placement: below the target if there's room, else above; clamped to
	// the viewport on both axes so it never spills off-screen at any breakpoint.
	const CARD_W = 300;
	const card = $derived.by(() => {
		if (!mounted) return { left: 0, top: 0, centered: true };
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		if (!rect) return { left: Math.round((vw - CARD_W) / 2), top: Math.round(vh * 0.4), centered: true };
		const below = rect.top + rect.height + PAD + 12;
		const wantBelow = below + 150 < vh;
		const top = wantBelow ? below : Math.max(12, rect.top - PAD - 12 - 150);
		let left = rect.left + rect.width / 2 - CARD_W / 2;
		left = Math.max(12, Math.min(left, vw - CARD_W - 12));
		return { left: Math.round(left), top: Math.round(top), centered: false };
	});
</script>

<svelte:window onkeydown={onKey} />

{#if open && mounted}
	<div class="tour-root" use:portal aria-live="polite">
		<!-- Dim everything except the spotlight. A single box with a huge spread
		     shadow is the cheapest cutout; pointer-events pass through the hole. -->
		{#if rect}
			<div
				class="tour-spotlight"
				class:reduce={reduceMotion()}
				style="top:{rect.top - PAD}px; left:{rect.left - PAD}px; width:{rect.width + PAD * 2}px; height:{rect.height +
					PAD * 2}px;"
			></div>
		{:else}
			<div class="tour-scrim"></div>
		{/if}

		<div
			class="tour-card"
			class:centered={card.centered}
			role="dialog"
			aria-modal="true"
			aria-label="Guided tour"
			style="left:{card.left}px; top:{card.top}px;"
		>
			<div class="tour-card-head">
				{#if brand}<span class="tour-brand">{@render brand()}</span>{/if}
				<span class="tour-progress">{index + 1} / {steps.length}</span>
				<button type="button" class="tour-close" aria-label="Close tour" onclick={finish}>
					<X size={15} aria-hidden="true" />
				</button>
			</div>
			<h3 class="tour-title">{step.title}</h3>
			<p class="tour-body">{step.body}</p>
			<div class="tour-actions">
				<button type="button" class="tour-skip" onclick={finish}>Skip</button>
				<div class="tour-nav">
					{#if !isFirst}
						<button type="button" class="tour-btn" onclick={back}>Back</button>
					{/if}
					<button type="button" class="tour-btn primary" onclick={next}>{isLast ? 'Done' : 'Next'}</button>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.tour-root {
		position: fixed;
		inset: 0;
		z-index: 200;
		pointer-events: none;
	}
	.tour-scrim,
	.tour-spotlight {
		position: fixed;
		pointer-events: auto;
	}
	.tour-scrim {
		inset: 0;
		background: rgba(6, 8, 14, 0.62);
	}
	.tour-spotlight {
		border-radius: 8px;
		box-shadow:
			0 0 0 9999px rgba(6, 8, 14, 0.62),
			0 0 0 1.5px var(--accent-amber);
		transition:
			top 0.25s ease,
			left 0.25s ease,
			width 0.25s ease,
			height 0.25s ease;
		/* The hole itself is click-through so the user can see the highlighted UI. */
		pointer-events: none;
	}
	.tour-spotlight.reduce {
		transition: none;
	}
	.tour-card {
		position: fixed;
		width: 300px;
		max-width: calc(100vw - 24px);
		pointer-events: auto;
		background: rgba(10, 13, 20, 0.97);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 10px;
		padding: 0.85rem 0.95rem 0.8rem;
		box-shadow: 0 10px 34px rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(8px);
		font-family: var(--font-sans, system-ui, sans-serif);
	}
	.tour-card-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.4rem;
	}
	.tour-brand {
		display: inline-flex;
		color: var(--accent-amber);
	}
	.tour-progress {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.66rem;
		opacity: 0.6;
		margin-left: auto;
	}
	.tour-close {
		background: none;
		border: none;
		color: rgba(233, 236, 243, 0.6);
		cursor: pointer;
		display: inline-flex;
		padding: 0.1rem;
	}
	.tour-close:hover {
		color: var(--accent-amber);
	}
	.tour-title {
		font-size: 0.92rem;
		font-weight: 600;
		margin: 0 0 0.3rem;
	}
	.tour-body {
		font-size: 0.78rem;
		line-height: 1.45;
		opacity: 0.86;
		margin: 0 0 0.7rem;
	}
	.tour-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.tour-nav {
		display: flex;
		gap: 0.4rem;
	}
	.tour-skip {
		background: none;
		border: none;
		color: rgba(233, 236, 243, 0.55);
		font-size: 0.72rem;
		cursor: pointer;
		padding: 0.3rem 0.1rem;
	}
	.tour-skip:hover {
		color: #e9ecf3;
	}
	.tour-btn {
		font-size: 0.74rem;
		padding: 0.34rem 0.7rem;
		border-radius: 6px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(255, 255, 255, 0.04);
		color: #e9ecf3;
		cursor: pointer;
	}
	.tour-btn:hover {
		background: rgba(255, 255, 255, 0.1);
	}
	.tour-btn.primary {
		background: var(--accent-amber);
		border-color: var(--accent-amber);
		color: #1a1206;
		font-weight: 600;
	}
	.tour-btn.primary:hover {
		filter: brightness(1.08);
	}
	@media (pointer: coarse) {
		.tour-btn,
		.tour-skip,
		.tour-close {
			min-height: 2.25rem;
		}
	}
</style>
