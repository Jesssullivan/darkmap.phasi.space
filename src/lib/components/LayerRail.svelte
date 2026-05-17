<script lang="ts">
	import type { RasterLayerDef } from '$lib/layers';

	export interface LayerState {
		on: boolean;
		opacity: number;
	}

	interface Props {
		layers: ReadonlyArray<RasterLayerDef>;
		states: Record<string, LayerState>;
		onchange: (id: string, partial: Partial<LayerState>) => void;
	}

	let { layers, states, onchange }: Props = $props();

	let drawerOpen = $state(false);
	const close = () => (drawerOpen = false);
</script>

<button
	class="rail-toggle"
	aria-label={drawerOpen ? 'Close layers' : 'Open layers'}
	aria-expanded={drawerOpen}
	onclick={() => (drawerOpen = !drawerOpen)}
>
	{#if drawerOpen}✕{:else}☰{/if}
	<span class="rail-toggle-label">Layers</span>
</button>

{#if drawerOpen}
	<div class="rail-backdrop" role="presentation" onclick={close} onkeydown={(e) => e.key === 'Escape' && close()}></div>
{/if}

<aside class="layer-rail" class:open={drawerOpen} aria-label="Map layers">
	<header>
		<h2>Layers</h2>
		<p>VIIRS · World Atlas · SQM</p>
	</header>
	<ul>
		{#each layers as layer (layer.id)}
			{@const ls = states[layer.id] ?? { on: false, opacity: layer.opacity }}
			<li>
				<label class="layer-toggle">
					<input
						type="checkbox"
						checked={ls.on}
						onchange={(e) => onchange(layer.id, { on: (e.target as HTMLInputElement).checked })}
					/>
					<span class="label">{layer.label}</span>
				</label>
				<div class="opacity-row">
					<input
						type="range"
						min="0"
						max="1"
						step="0.05"
						value={ls.opacity}
						disabled={!ls.on}
						aria-label="{layer.label} opacity"
						oninput={(e) => onchange(layer.id, { opacity: Number((e.target as HTMLInputElement).value) })}
					/>
					<span class="opacity-pct" aria-hidden="true">{Math.round(ls.opacity * 100)}%</span>
				</div>
				<p class="desc">{layer.description}</p>
			</li>
		{/each}
	</ul>
</aside>

<style>
	.rail-toggle {
		position: fixed;
		top: 4.25rem;
		left: 1rem;
		z-index: 12;
		background: rgba(8, 10, 16, 0.85);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 6px;
		padding: 0.45rem 0.7rem;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85rem;
		cursor: pointer;
		backdrop-filter: blur(6px);
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}
	.rail-toggle:focus-visible {
		outline: 2px solid #ffd166;
		outline-offset: 2px;
	}
	.rail-toggle-label {
		display: none;
	}

	.rail-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.35);
		z-index: 9;
		animation: fade-in 0.15s ease-out;
	}

	.layer-rail {
		position: fixed;
		top: 7rem;
		left: 1rem;
		max-width: 18rem;
		max-height: calc(100vh - 9rem);
		overflow-y: auto;
		padding: 1rem 1.25rem;
		background: rgba(8, 10, 16, 0.85);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 8px;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85rem;
		z-index: 10;
		backdrop-filter: blur(6px);
		animation: fade-in 0.2s ease-out;
	}

	@keyframes fade-in {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	header h2 {
		margin: 0 0 0.25rem 0;
		font-size: 1rem;
		letter-spacing: 0.02em;
	}
	header p {
		margin: 0 0 0.75rem 0;
		opacity: 0.55;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	ul {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}
	.layer-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}
	.label {
		font-weight: 500;
	}
	.opacity-row {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.5rem;
		align-items: center;
		margin-top: 0.25rem;
		padding-left: 1.5rem;
	}
	.opacity-row input[type='range'] {
		width: 100%;
		accent-color: #ffd166;
	}
	.opacity-row input[type='range']:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.opacity-pct {
		font-variant-numeric: tabular-nums;
		font-size: 0.7rem;
		opacity: 0.65;
		min-width: 2.6em;
		text-align: right;
	}
	.desc {
		margin: 0.25rem 0 0 1.5rem;
		opacity: 0.6;
		font-size: 0.72rem;
		line-height: 1.35;
	}
	input[type='checkbox'] {
		accent-color: #ffd166;
	}

	@media (max-width: 640px) {
		.rail-toggle-label {
			display: inline;
		}
		.layer-rail {
			top: 0;
			left: 0;
			max-width: 100vw;
			width: 88vw;
			max-height: 100vh;
			height: 100vh;
			border-radius: 0;
			border-right: 1px solid rgba(255, 255, 255, 0.08);
			border-top: 0;
			border-bottom: 0;
			border-left: 0;
			padding-top: 4rem;
			transform: translateX(-100%);
			transition: transform 0.2s ease-out;
			animation: none;
		}
		.layer-rail.open {
			transform: translateX(0);
		}
	}

	@media (min-width: 641px) {
		.rail-toggle {
			display: none;
		}
		.rail-backdrop {
			display: none;
		}
	}
</style>
