<script lang="ts">
	/**
	 * AqModal — the in-SPA roomy modal-popout that hosts the AQ dashboard (TIN-1871,
	 * idea ③). The /aq dashboard used to be a dedicated route (slug + history churn);
	 * because AQ is viewport/pin-driven it doesn't need one. This is an operator-
	 * sanctioned transient surface (like a command palette): focus-trapped, Esc-to-
	 * close, returns focus on close, a visible close button. The map + Command Deck
	 * stay live behind it — this is NOT a persistent map-obscurer, so the no-scrim
	 * rule (which targets persistent panels) doesn't apply.
	 *
	 * Roomy on desktop (centred, max ~min(960px, 92vw) × 88vh, scroll INSIDE); a
	 * near-fullscreen sheet at COMPACT with a thin map strip kept above it (the
	 * never-100% spirit). Viewport/pin-driven: the hosted AqDashboard reuses the
	 * existing getSensors(bbox) ±0.75° fetch — opening it is not a route navigation.
	 */
	import { onMount, tick } from 'svelte';
	import { X } from '@lucide/svelte';
	import { portal } from '$lib/actions/portal';
	import AqDashboard, { type AqSeed } from '$lib/components/AqDashboard.svelte';

	interface Props {
		open: boolean;
		/** Seed point/time (pinned map point or shareable hash); piped to the dashboard. */
		seed?: AqSeed | null;
		/** Close the modal (clears `open` in the host). */
		onClose: () => void;
		/** "View on map" — close the modal and recentre the map on the analysed point. */
		onViewOnMap?: (at: { lat: number; lon: number }) => void;
	}

	let { open, seed = null, onClose, onViewOnMap }: Props = $props();

	let dialogEl = $state<HTMLDivElement | null>(null);
	let closeEl = $state<HTMLButtonElement | null>(null);
	// The element focus returns to on close (the launcher/CTA that opened us).
	let returnFocusEl: HTMLElement | null = null;

	const FOCUSABLE =
		'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

	function focusables(): HTMLElement[] {
		if (!dialogEl) return [];
		return Array.from(dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
			(el) => el.offsetParent !== null || el === document.activeElement,
		);
	}

	// On open: remember what had focus, move focus into the dialog (the close
	// button), and lock the trap. On close: restore focus to the opener.
	$effect(() => {
		if (open) {
			returnFocusEl = (document.activeElement as HTMLElement | null) ?? null;
			void tick().then(() => {
				closeEl?.focus();
			});
		} else if (returnFocusEl) {
			const el = returnFocusEl;
			returnFocusEl = null;
			// Defer so the close handler's own state settles before focus returns.
			void tick().then(() => el.focus?.());
		}
	});

	function onKeydown(e: KeyboardEvent): void {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			onClose();
			return;
		}
		if (e.key !== 'Tab') return;
		// Hand-rolled focus-trap (no dep): wrap Tab/Shift+Tab inside the dialog.
		const els = focusables();
		if (els.length === 0) {
			e.preventDefault();
			closeEl?.focus();
			return;
		}
		const first = els[0];
		const last = els[els.length - 1];
		const active = document.activeElement as HTMLElement | null;
		if (e.shiftKey) {
			if (active === first || !dialogEl?.contains(active)) {
				e.preventDefault();
				last.focus();
			}
		} else if (active === last) {
			e.preventDefault();
			first.focus();
		}
	}

	function viewOnMap(): void {
		if (seed && onViewOnMap) onViewOnMap({ lat: seed.lat, lon: seed.lon });
		else onClose();
	}

	// Belt-and-braces: if the host tears us down while open, nothing to restore
	// since the effect cleanup already ran; this just documents intent.
	onMount(() => () => {});
</script>

{#if open}
	<!-- Portaled to <body> so the Command Deck grid / stacking context can't clip or
	     reorder the modal. Keydown is captured on the root so Tab/Esc are trapped. -->
	<div
		class="aq-modal-root"
		use:portal
		role="dialog"
		aria-modal="true"
		aria-label="Air-quality analysis"
		data-aq-modal="open"
		onkeydowncapture={onKeydown}
	>
		<!-- A faint backdrop for focus, NOT an opaque scrim: the map/deck stay visible
		     and live behind it. Clicking it closes (transient-surface convention). -->
		<div
			class="aq-modal-backdrop"
			role="presentation"
			onclick={onClose}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') onClose();
			}}
			tabindex="-1"
		></div>
		<div class="aq-modal-panel" bind:this={dialogEl}>
			<header class="aq-modal-bar">
				<span class="aq-modal-eyebrow">Air quality · analysis</span>
				<button
					type="button"
					class="aq-modal-close"
					bind:this={closeEl}
					aria-label="Close air-quality analysis"
					data-aq-modal-close
					onclick={onClose}
				>
					<X size={18} aria-hidden="true" />
				</button>
			</header>
			<div class="aq-modal-body">
				<AqDashboard {seed} onViewOnMap={onViewOnMap ? viewOnMap : undefined} />
			</div>
		</div>
	</div>
{/if}

<style>
	.aq-modal-root {
		position: fixed;
		inset: 0;
		z-index: 1200;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 4vh 1rem;
	}
	.aq-modal-backdrop {
		position: absolute;
		inset: 0;
		/* Faint, not opaque — the map + Command Deck stay legible behind it. */
		background: light-dark(rgba(8, 10, 14, 0.28), rgba(2, 3, 6, 0.42));
		backdrop-filter: blur(1.5px);
		border: 0;
		cursor: default;
	}
	.aq-modal-panel {
		position: relative;
		display: flex;
		flex-direction: column;
		width: min(960px, 92vw);
		max-height: 88vh;
		background: light-dark(#f7f8fb, #0b0e15);
		color: light-dark(#10131a, #e9ecf3);
		border: 1px solid light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.12));
		border-radius: 14px;
		box-shadow:
			0 18px 60px rgba(0, 0, 0, 0.55),
			0 2px 8px rgba(0, 0, 0, 0.4);
		overflow: hidden;
	}
	.aq-modal-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.65rem 0.75rem 0.65rem 1rem;
		border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
		flex: 0 0 auto;
	}
	.aq-modal-eyebrow {
		font-size: 0.68rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		opacity: 0.6;
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.aq-modal-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 8px;
		border: 1px solid light-dark(rgba(0, 0, 0, 0.15), rgba(255, 255, 255, 0.15));
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.aq-modal-close:hover {
		background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.08));
	}
	.aq-modal-close:focus-visible {
		outline: 2px solid var(--accent-amber, #f0b429);
		outline-offset: 2px;
	}
	.aq-modal-body {
		flex: 1 1 auto;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 1rem 1.25rem 1.5rem;
		-webkit-overflow-scrolling: touch;
	}

	/* COMPACT (<640px): a near-fullscreen sheet, but keep a thin map strip above it
	   (the never-100% spirit) — the panel tops out below the viewport top, scroll
	   stays inside. The map/deck remain live behind the faint backdrop. */
	@media (max-width: 639px) {
		.aq-modal-root {
			padding: 0;
			align-items: stretch;
		}
		.aq-modal-panel {
			width: 100%;
			max-height: none;
			height: calc(100vh - 64px);
			/* dvh tracks the iOS dynamic toolbar (a fixed 100vh height clips on iOS). */
			height: calc(100dvh - 64px);
			margin-top: auto;
			border-radius: 14px 14px 0 0;
			border-bottom: 0;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.aq-modal-panel {
			animation: aq-modal-in 140ms ease-out;
		}
	}
	@keyframes aq-modal-in {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.99);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
</style>
