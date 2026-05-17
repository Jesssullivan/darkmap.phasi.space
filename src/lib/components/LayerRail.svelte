<script lang="ts">
	import type { RasterLayerDef } from '$lib/layers';

	interface Props {
		layers: ReadonlyArray<RasterLayerDef>;
		enabled: Record<string, boolean>;
		ontoggle: (id: string, on: boolean) => void;
	}

	let { layers, enabled, ontoggle }: Props = $props();
</script>

<aside class="layer-rail" aria-label="Map layers">
	<header>
		<h2>Layers</h2>
		<p>VIIRS · World Atlas · SQM</p>
	</header>
	<ul>
		{#each layers as layer (layer.id)}
			<li>
				<label>
					<input
						type="checkbox"
						checked={enabled[layer.id] ?? false}
						onchange={(e) => ontoggle(layer.id, (e.target as HTMLInputElement).checked)}
					/>
					<span class="label">{layer.label}</span>
				</label>
				<p class="desc">{layer.description}</p>
			</li>
		{/each}
	</ul>
</aside>

<style>
	.layer-rail {
		position: absolute;
		top: 1rem;
		left: 1rem;
		max-width: 18rem;
		padding: 1rem 1.25rem;
		background: rgba(8, 10, 16, 0.85);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 8px;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85rem;
		z-index: 10;
		backdrop-filter: blur(6px);
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
		gap: 0.65rem;
	}
	label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}
	.label {
		font-weight: 500;
	}
	.desc {
		margin: 0.15rem 0 0 1.5rem;
		opacity: 0.6;
		font-size: 0.72rem;
		line-height: 1.35;
	}
	input[type='checkbox'] {
		accent-color: #ffd166;
	}
</style>
