<script lang="ts">
	/**
	 * GeocoderSearch — Svelte 5 combobox over the `/api/geocode` proxy.
	 *
	 * Behavior:
	 *   • Debounce (default 250ms) so we don't fan out a request per
	 *     keystroke
	 *   • Coordinate inputs short-circuit to onSelect — no network hit
	 *   • Up/Down arrows navigate the dropdown; Enter selects; Esc closes
	 *   • Optional viewport bias so a "Cherry" search near Ithaca ranks
	 *     local hits first
	 *
	 * The component owns no map state — `onSelect` is the boundary; the
	 * parent decides whether to flyTo, push the hash, etc.
	 */

	import { dispatchSearchInput } from '$lib/geocoder/coordParser';
	import type { GeocodeResult } from '$lib/server/geocoder/GeocoderClient';

	interface Props {
		bias?: { lat: number; lon: number };
		debounceMs?: number;
		placeholder?: string;
		onSelect: (sel: { lat: number; lon: number; label: string }) => void;
	}

	let { bias, debounceMs = 250, placeholder = 'Search place or paste coords…', onSelect }: Props = $props();

	let query = $state('');
	let results = $state<readonly GeocodeResult[]>([]);
	let loading = $state(false);
	let error = $state('');
	let open = $state(false);
	let selectedIndex = $state(0);

	let debounceHandle: ReturnType<typeof setTimeout> | undefined;
	let inflight: AbortController | undefined;

	const runSearch = async (q: string): Promise<void> => {
		inflight?.abort();
		const ctl = new AbortController();
		inflight = ctl;
		loading = true;
		error = '';
		try {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, not stored in state
			const params = new URLSearchParams({ q });
			if (bias) {
				params.set('lat', String(bias.lat));
				params.set('lon', String(bias.lon));
			}
			const res = await fetch(`/api/geocode?${params}`, { signal: ctl.signal });
			if (!res.ok) {
				error = `geocoder ${res.status}`;
				results = [];
				return;
			}
			const body = (await res.json()) as { results: GeocodeResult[] };
			results = body.results;
			selectedIndex = 0;
		} catch (e) {
			if ((e as DOMException).name === 'AbortError') return;
			error = e instanceof Error ? e.message : 'geocoder failed';
			results = [];
		} finally {
			if (inflight === ctl) loading = false;
		}
	};

	const onInput = (ev: Event): void => {
		const value = (ev.target as HTMLInputElement).value;
		query = value;
		open = value.trim().length > 0;
		clearTimeout(debounceHandle);
		const dispatch = dispatchSearchInput(value);
		if (dispatch.kind === 'empty') {
			results = [];
			loading = false;
			return;
		}
		if (dispatch.kind === 'coord') {
			// Short-circuit: no network, single synthetic result so the user
			// sees an explicit "go to coordinate" affordance.
			results = [
				{
					name: `${dispatch.coord.lat.toFixed(4)}, ${dispatch.coord.lon.toFixed(4)}`,
					context: `coord (${dispatch.coord.format.toUpperCase()})`,
					lat: dispatch.coord.lat,
					lon: dispatch.coord.lon,
					score: 1,
				},
			];
			selectedIndex = 0;
			loading = false;
			return;
		}
		debounceHandle = setTimeout(() => {
			void runSearch(dispatch.q);
		}, debounceMs);
	};

	const choose = (r: GeocodeResult): void => {
		onSelect({ lat: r.lat, lon: r.lon, label: r.context ? `${r.name} · ${r.context}` : r.name });
		open = false;
		query = r.name;
	};

	const onKey = (ev: KeyboardEvent): void => {
		if (ev.key === 'ArrowDown') {
			ev.preventDefault();
			open = true;
			selectedIndex = Math.min(results.length - 1, selectedIndex + 1);
		} else if (ev.key === 'ArrowUp') {
			ev.preventDefault();
			selectedIndex = Math.max(0, selectedIndex - 1);
		} else if (ev.key === 'Enter') {
			if (results.length > 0 && open) {
				ev.preventDefault();
				choose(results[selectedIndex]);
			}
		} else if (ev.key === 'Escape') {
			open = false;
		}
	};

	const onBlur = (): void => {
		// Delay closing so a click on a result has time to land.
		setTimeout(() => {
			open = false;
		}, 150);
	};
</script>

<div class="geocoder" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls="geocoder-listbox">
	<input
		type="search"
		class="search-input"
		{placeholder}
		value={query}
		oninput={onInput}
		onkeydown={onKey}
		onblur={onBlur}
		onfocus={() => (open = query.trim().length > 0)}
		aria-label="Search place or coordinates"
		aria-autocomplete="list"
		autocomplete="off"
		spellcheck="false"
	/>
	{#if loading}
		<span class="status" aria-live="polite">…</span>
	{:else if error}
		<span class="status err" role="alert">{error}</span>
	{/if}
	{#if open && results.length > 0}
		<ul id="geocoder-listbox" class="dropdown" role="listbox">
			{#each results as r, i (`${r.lat},${r.lon},${i}`)}
				<li
					role="option"
					aria-selected={i === selectedIndex}
					class:active={i === selectedIndex}
					onmousedown={(ev) => {
						ev.preventDefault();
						choose(r);
					}}
				>
					<div class="row">
						<span class="name">{r.name || '(unnamed)'}</span>
						{#if r.context}<span class="context">{r.context}</span>{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.geocoder {
		position: fixed;
		top: 1rem;
		left: 50%;
		transform: translateX(-50%);
		z-index: 11;
		width: min(28rem, calc(100vw - 6rem));
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.search-input {
		width: 100%;
		background: rgba(8, 10, 16, 0.85);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 999px;
		padding: 0.5rem 1rem;
		font: inherit;
		font-size: 0.85rem;
		backdrop-filter: blur(6px);
	}
	.search-input::placeholder {
		color: rgba(233, 236, 243, 0.45);
	}
	.search-input:focus-visible {
		outline: 2px solid var(--accent-amber);
		outline-offset: 2px;
	}
	.status {
		position: absolute;
		right: 1rem;
		top: 50%;
		transform: translateY(-50%);
		font-size: 0.75rem;
		opacity: 0.7;
	}
	.status.err {
		color: rgba(255, 120, 120, 0.85);
	}
	.dropdown {
		list-style: none;
		margin: 0.35rem 0 0;
		padding: 0.25rem 0;
		background: rgba(8, 10, 16, 0.92);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 8px;
		max-height: 18rem;
		overflow-y: auto;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
		backdrop-filter: blur(8px);
	}
	li {
		padding: 0.4rem 0.85rem;
		font-size: 0.78rem;
		cursor: pointer;
		color: #e9ecf3;
	}
	li.active,
	li:hover {
		background: rgba(var(--accent-amber-rgb), 0.12);
		color: var(--accent-amber);
	}
	.row {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}
	.name {
		font-weight: 600;
	}
	.context {
		opacity: 0.6;
		font-size: 0.7rem;
	}
</style>
