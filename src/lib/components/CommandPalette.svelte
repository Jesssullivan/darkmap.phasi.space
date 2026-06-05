<script lang="ts">
	/**
	 * CommandPalette — the Cmd/Ctrl-K command palette (W5e). A focus-trapped,
	 * portal-to-body transient surface forked from AqModal's trap/portal pattern
	 * (operator-sanctioned, like the AQ popout): Esc-to-close, returns focus on
	 * close, the map + Command Deck stay live behind a faint (non-opaque) backdrop.
	 *
	 * Every deck action that has a keyboard/clickable home is reachable here by
	 * fuzzy search — lens switches, the four deep tools, layers, the tour, basemap.
	 * Presentational only: the host (+page.svelte) owns the command list + closures;
	 * this renders a combobox + listbox and calls `cmd.run()`.
	 */
	import { tick } from 'svelte';
	import { Search } from '@lucide/svelte';
	import { portal } from '$lib/actions/portal';

	export interface PaletteCommand {
		id: string;
		label: string;
		/** Short trailing hint (e.g. the key chord) shown right-aligned. */
		hint?: string;
		/** Extra match terms beyond the label (space-separated). */
		keywords?: string;
		run: () => void;
	}

	interface Props {
		open: boolean;
		commands: PaletteCommand[];
		onClose: () => void;
	}

	let { open, commands, onClose }: Props = $props();

	let dialogEl = $state<HTMLDivElement | null>(null);
	let inputEl = $state<HTMLInputElement | null>(null);
	let query = $state('');
	let activeIndex = $state(0);
	let returnFocusEl: HTMLElement | null = null;

	// Cheap subsequence-ish fuzzy: every whitespace token of the query must appear
	// (substring) in the command's "label + keywords" haystack. Order-preserving by
	// the declared command order — no scoring, predictable for a 13-item set.
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return commands;
		const tokens = q.split(/\s+/);
		return commands.filter((c) => {
			const hay = `${c.label} ${c.keywords ?? ''}`.toLowerCase();
			return tokens.every((t) => hay.includes(t));
		});
	});

	// Keep the active row in range as the filtered set shrinks/grows.
	$effect(() => {
		// re-clamp whenever the filtered length changes
		const n = filtered.length;
		if (activeIndex > n - 1) activeIndex = Math.max(0, n - 1);
	});

	// On open: remember focus, reset query/selection, focus the input. On close:
	// restore focus to the opener (the deck/element that had focus).
	$effect(() => {
		if (open) {
			returnFocusEl = (document.activeElement as HTMLElement | null) ?? null;
			query = '';
			activeIndex = 0;
			void tick().then(() => inputEl?.focus());
		} else if (returnFocusEl) {
			const el = returnFocusEl;
			returnFocusEl = null;
			void tick().then(() => el.focus?.());
		}
	});

	function runAt(i: number): void {
		const cmd = filtered[i];
		if (!cmd) return;
		onClose();
		// Defer so the close + focus-restore settle before the command mutates state.
		void tick().then(() => cmd.run());
	}

	function onKeydown(e: KeyboardEvent): void {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			onClose();
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIndex = filtered.length ? (activeIndex + 1) % filtered.length : 0;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIndex = filtered.length ? (activeIndex - 1 + filtered.length) % filtered.length : 0;
		} else if (e.key === 'Home') {
			e.preventDefault();
			activeIndex = 0;
		} else if (e.key === 'End') {
			e.preventDefault();
			activeIndex = Math.max(0, filtered.length - 1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			runAt(activeIndex);
		}
		// (No Tab trap needed beyond Esc: the only focusable is the input; the listbox
		//  rows are driven by aria-activedescendant, not real focus. We still keep focus
		//  pinned to the input below.)
	}

	// Belt-and-braces focus pin: if focus ever leaves the input while open (e.g. a
	// stray click), Tab is swallowed back to the input so the palette stays trapped.
	function onRootKeydownCapture(e: KeyboardEvent): void {
		if (e.key === 'Tab') {
			e.preventDefault();
			inputEl?.focus();
		}
	}
</script>

{#if open}
	<!-- Portaled to <body> so the Command Deck grid / stacking context can't clip it. -->
	<div
		class="cmdk-root"
		use:portal
		role="dialog"
		aria-modal="true"
		aria-label="Command palette"
		data-command-palette="open"
		onkeydowncapture={onRootKeydownCapture}
	>
		<div
			class="cmdk-backdrop"
			role="presentation"
			onclick={onClose}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') onClose();
			}}
			tabindex="-1"
		></div>
		<div class="cmdk-panel" bind:this={dialogEl} onkeydown={onKeydown}>
			<div class="cmdk-search">
				<Search size={16} aria-hidden="true" />
				<input
					bind:this={inputEl}
					bind:value={query}
					type="text"
					class="cmdk-input"
					role="combobox"
					aria-expanded="true"
					aria-controls="cmdk-listbox"
					aria-activedescendant={filtered[activeIndex] ? `cmdk-opt-${filtered[activeIndex].id}` : undefined}
					aria-label="Search commands"
					placeholder="Search commands…"
					autocomplete="off"
					spellcheck="false"
				/>
			</div>
			<ul id="cmdk-listbox" class="cmdk-list" role="listbox" aria-label="Commands">
				{#each filtered as cmd, i (cmd.id)}
					<li
						id={`cmdk-opt-${cmd.id}`}
						class="cmdk-opt"
						class:active={i === activeIndex}
						role="option"
						aria-selected={i === activeIndex}
						onclick={() => runAt(i)}
						onmousemove={() => (activeIndex = i)}
					>
						<span class="cmdk-opt-label">{cmd.label}</span>
						{#if cmd.hint}<span class="cmdk-opt-hint">{cmd.hint}</span>{/if}
					</li>
				{:else}
					<li class="cmdk-empty" role="option" aria-selected="false" aria-disabled="true">No matching command</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}

<style>
	.cmdk-root {
		position: fixed;
		inset: 0;
		z-index: 1200;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 12vh 1rem 1rem;
	}
	.cmdk-backdrop {
		position: absolute;
		inset: 0;
		/* Faint, not opaque — the map + Command Deck stay legible behind it. */
		background: light-dark(rgba(8, 10, 14, 0.28), rgba(2, 3, 6, 0.42));
		backdrop-filter: blur(1.5px);
		border: 0;
		cursor: default;
	}
	.cmdk-panel {
		position: relative;
		display: flex;
		flex-direction: column;
		width: min(560px, 94vw);
		max-height: 70vh;
		background: light-dark(#f7f8fb, #0b0e15);
		color: light-dark(#10131a, #e9ecf3);
		border: 1px solid light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.14));
		border-radius: 12px;
		box-shadow:
			0 18px 60px rgba(0, 0, 0, 0.55),
			0 2px 8px rgba(0, 0, 0, 0.4);
		overflow: hidden;
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.cmdk-search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.7rem 0.85rem;
		border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
		flex: 0 0 auto;
		color: light-dark(rgba(0, 0, 0, 0.5), rgba(233, 236, 243, 0.6));
	}
	.cmdk-input {
		flex: 1 1 auto;
		min-width: 0;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 0.95rem;
		outline: none;
	}
	.cmdk-list {
		list-style: none;
		margin: 0;
		padding: 0.35rem;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}
	.cmdk-opt {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.5rem 0.6rem;
		border-radius: 7px;
		cursor: pointer;
		font-size: 0.82rem;
		line-height: 1.2;
	}
	/* Active row — fill + the active lens accent border, never colour alone. */
	.cmdk-opt.active {
		background: rgba(var(--lens-accent-rgb, var(--accent-amber-rgb)), 0.14);
		outline: 1px solid rgba(var(--lens-accent-rgb, var(--accent-amber-rgb)), 0.55);
	}
	.cmdk-opt-label {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.cmdk-opt-hint {
		flex: 0 0 auto;
		font-size: 0.66rem;
		letter-spacing: 0.04em;
		opacity: 0.6;
		text-transform: uppercase;
	}
	.cmdk-empty {
		padding: 0.7rem 0.6rem;
		font-size: 0.8rem;
		opacity: 0.6;
		list-style: none;
	}

	/* COMPACT (<640px): a top sheet that keeps a thin map strip above it. */
	@media (max-width: 639px) {
		.cmdk-root {
			padding: 0;
			align-items: stretch;
		}
		.cmdk-panel {
			width: 100%;
			max-height: calc(100vh - 56px);
			margin-top: 56px;
			border-radius: 0 0 12px 12px;
			border-top: 0;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.cmdk-panel {
			animation: cmdk-in 130ms ease-out;
		}
	}
	@keyframes cmdk-in {
		from {
			opacity: 0;
			transform: translateY(-6px) scale(0.99);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
</style>
