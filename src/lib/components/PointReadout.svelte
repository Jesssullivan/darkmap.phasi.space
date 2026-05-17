<script lang="ts">
	export interface ReadoutData {
		readonly viirs?: {
			readonly layer: string;
			readonly red: number;
			readonly green: number;
			readonly blue: number;
			readonly alpha: number;
		};
		readonly worldAtlas?: {
			readonly grayIndex: number;
		};
	}

	interface Props {
		lat: number;
		lon: number;
		data: ReadoutData | undefined;
		loading: boolean;
		error?: string;
		onclose: () => void;
	}

	let { lat, lon, data, loading, error, onclose }: Props = $props();

	const fmtCoord = (n: number) => n.toFixed(4);
	// Brightness of a VIIRS pixel: average the RGB. The styled palette runs
	// dark -> bright so the average is a usable single-number indicator.
	const viirsAvg = $derived.by(() =>
		data?.viirs ? Math.round((data.viirs.red + data.viirs.green + data.viirs.blue) / 3) : undefined,
	);
	// Falchi 2015 brightness classes: < 8 = wilderness, 8-32 = rural, 32-87 = suburban, > 87 = urban.
	// Source: Falchi et al. 2016 World Atlas, Table 1 (mcd/m² ratios).
	const waClass = $derived.by(() => {
		const g = data?.worldAtlas?.grayIndex;
		if (g === undefined) return undefined;
		if (g < 1) return 'Pristine';
		if (g < 8) return 'Wilderness';
		if (g < 32) return 'Rural';
		if (g < 87) return 'Suburban';
		if (g < 460) return 'Urban';
		return 'Inner city';
	});
</script>

<div class="readout" role="dialog" aria-label="Point readout">
	<button class="close" type="button" aria-label="Close readout" onclick={onclose}>✕</button>
	<header>
		<h3>Point readout</h3>
		<p>{fmtCoord(lat)}°, {fmtCoord(lon)}°</p>
	</header>
	{#if loading}
		<p class="loading">Querying upstream…</p>
	{:else if error}
		<p class="error">Error: {error}</p>
	{:else if data}
		{#if data.viirs}
			<section>
				<h4>VIIRS pixel</h4>
				<p class="value">{viirsAvg}<span class="unit">/255</span></p>
				<p class="note">{data.viirs.layer} · RGB({data.viirs.red},{data.viirs.green},{data.viirs.blue})</p>
			</section>
		{/if}
		{#if data.worldAtlas}
			<section>
				<h4>World Atlas radiance</h4>
				<p class="value">{data.worldAtlas.grayIndex.toFixed(2)}<span class="unit"> mcd/m²</span></p>
				{#if waClass}
					<p class="note">Falchi 2016: <strong>{waClass}</strong></p>
				{/if}
			</section>
		{/if}
		{#if !data.viirs && !data.worldAtlas}
			<p class="loading">No data at this point.</p>
		{/if}
	{/if}
</div>

<style>
	.readout {
		position: fixed;
		bottom: 4rem;
		right: 1rem;
		min-width: 16rem;
		max-width: 22rem;
		padding: 1rem 1.25rem;
		background: rgba(8, 10, 16, 0.92);
		color: #e9ecf3;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85rem;
		z-index: 11;
		backdrop-filter: blur(8px);
		animation: slide-up 0.18s ease-out;
	}
	@keyframes slide-up {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	.close {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		background: none;
		border: none;
		color: rgba(233, 236, 243, 0.55);
		font-size: 1rem;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
	}
	.close:hover {
		color: #ffd166;
	}
	header h3 {
		margin: 0 0 0.15rem 0;
		font-size: 0.95rem;
	}
	header p {
		margin: 0 0 0.75rem 0;
		opacity: 0.6;
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}
	section {
		margin-top: 0.85rem;
		padding-top: 0.65rem;
		border-top: 1px solid rgba(255, 255, 255, 0.06);
	}
	section h4 {
		margin: 0 0 0.25rem 0;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		opacity: 0.65;
	}
	.value {
		margin: 0;
		font-size: 1.3rem;
		font-weight: 600;
		color: #ffd166;
		font-variant-numeric: tabular-nums;
	}
	.unit {
		font-size: 0.75rem;
		opacity: 0.7;
		font-weight: 400;
		margin-left: 0.2rem;
	}
	.note {
		margin: 0.25rem 0 0 0;
		font-size: 0.72rem;
		opacity: 0.7;
	}
	.loading {
		opacity: 0.55;
		font-style: italic;
		margin: 0.5rem 0 0 0;
	}
	.error {
		color: #ff6b6b;
		margin: 0.5rem 0 0 0;
	}
</style>
