<script lang="ts">
	/**
	 * LensSwitcher — the persistent persona-lens header (S1 PR2).
	 *
	 * Four icon+label chips (Sky · Air · Links · Orbit) in `LENSES` order. The
	 * active chip is distinguished by FILL + WEIGHT, never colour alone (filled
	 * amber pill + bold dark label), honouring the ColorVision-Assist commitment
	 * — see docs/ux/personas-and-lenses.md §11.4.
	 *
	 * One-action switch; the same lenses are reachable via number keys 1–4 (the
	 * accelerator lives in +page.svelte). The switch only re-weights the derived
	 * surfaces (PR4/PR5) — it never touches the map's centre/zoom/marker/time.
	 *
	 * ≤820px the labels fold away to a compact icon-only segmented row centred
	 * under the geocoder pill (never a keyboard-only palette). Icons are Lucide,
	 * matching the toolbar (#136 emoji→Lucide swap).
	 */
	import type { Component } from 'svelte';
	import { Cloud, MoonStar, RadioTower, Satellite } from '@lucide/svelte';
	import { LENSES, type Lens } from '$lib/lens';

	interface Props {
		/** Currently active lens (bind to `lensStore.lens`). */
		active: Lens;
		/** Fired on chip click; the parent calls `lensStore.set` + `scheduleHashWrite`. */
		onselect: (lens: Lens) => void;
	}

	let { active, onselect }: Props = $props();

	interface Chip {
		readonly id: Lens;
		readonly label: string;
		readonly icon: Component;
		/** Tooltip + the number-key hint (mirrors the 1–4 accelerator). */
		readonly hint: string;
	}

	// Declared in LENSES order so chip index === number-key (1→sky … 4→orbit).
	const CHIPS: readonly Chip[] = [
		{ id: 'sky', label: 'Sky', icon: MoonStar, hint: 'Dark-sky & astro (key 1)' },
		{ id: 'air', label: 'Air', icon: Cloud, hint: 'Weather, smog & air quality (key 2)' },
		{ id: 'links', label: 'Links', icon: RadioTower, hint: 'RF / laser link budget (key 3)' },
		{ id: 'orbit', label: 'Orbit', icon: Satellite, hint: 'LEO passes & ground station (key 4)' },
	];

	// Dev-only guard: keep the chip list in lockstep with the canonical order.
	if (import.meta.env?.DEV && CHIPS.map((c) => c.id).join() !== LENSES.join()) {
		console.warn('[LensSwitcher] CHIPS order drifted from LENSES', CHIPS, LENSES);
	}
</script>

<nav class="lens-switcher" aria-label="Map lens" data-tour="lens-switcher">
	{#each CHIPS as chip (chip.id)}
		{@const Icon = chip.icon}
		<button
			type="button"
			class="chip"
			class:active={active === chip.id}
			aria-label={chip.label}
			aria-pressed={active === chip.id}
			title={chip.hint}
			onclick={() => onselect(chip.id)}
		>
			<Icon size={16} aria-hidden="true" />
			<span class="chip-label">{chip.label}</span>
		</button>
	{/each}
</nav>

<style>
	.lens-switcher {
		position: fixed;
		top: max(1rem, env(safe-area-inset-top));
		left: max(1rem, env(safe-area-inset-left));
		z-index: 12;
		display: flex;
		gap: 0.4rem;
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		background: rgba(8, 10, 16, 0.85);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 999px;
		padding: 0.4rem 0.7rem;
		font: inherit;
		font-size: 0.8rem;
		line-height: 1;
		cursor: pointer;
		backdrop-filter: blur(6px);
		min-height: 2.5rem;
		white-space: nowrap;
	}
	.chip:hover:not(.active) {
		border-color: rgba(var(--accent-amber-rgb), 0.65);
		color: var(--accent-amber);
	}
	/* Active state — fill + weight, not colour alone (ColorVision-Assist). */
	.chip.active {
		background: var(--accent-amber);
		border-color: var(--accent-amber);
		color: #0a0a0a;
		font-weight: 700;
	}
	.chip:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 2px;
	}
	@media (pointer: coarse) {
		.chip {
			/* ~44x44 minimum touch target (incl. the icon-only mobile chips). */
			min-height: 2.75rem;
			min-width: 2.75rem;
		}
	}
	/* ≤820px: compact icon-only segmented row, centred under the geocoder pill. */
	@media (max-width: 820px) {
		.lens-switcher {
			left: 50%;
			right: auto;
			transform: translateX(-50%);
			top: max(3.75rem, calc(env(safe-area-inset-top) + 2.75rem));
			gap: 0.4rem;
		}
		.chip {
			padding: 0.4rem 0.55rem;
		}
		.chip-label {
			/* Visually hidden; aria-label keeps the chip named for AT. */
			position: absolute;
			width: 1px;
			height: 1px;
			padding: 0;
			margin: -1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
			white-space: nowrap;
			border: 0;
		}
	}
</style>
