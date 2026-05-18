<script lang="ts">
	import type { ColorRamp } from '$lib/color-ramps';

	interface Props {
		ramp: ColorRamp;
		title: string;
	}

	let { ramp, title }: Props = $props();

	// Map each stop to a 0..1 position along the gradient axis. For log
	// scales (WA_2015), use log10. The first stop maps to 0; the last to 1.
	const positions = $derived.by(() => {
		const xs = ramp.stops.map((s) => s.value);
		if (ramp.logScale) {
			// Substitute 0 with the next-smallest positive value's tenth so log10 stays finite.
			const min = Math.min(...xs.filter((v) => v > 0));
			const safe = xs.map((v) => (v <= 0 ? min / 10 : v));
			const lo = Math.log10(safe[0]);
			const hi = Math.log10(safe[safe.length - 1]);
			return safe.map((v) => (Math.log10(v) - lo) / (hi - lo));
		}
		const lo = xs[0];
		const hi = xs[xs.length - 1];
		return xs.map((v) => (v - lo) / (hi - lo));
	});

	const gradient = $derived(
		'linear-gradient(to right, ' +
			ramp.stops.map((s, i) => `${s.color} ${(positions[i] * 100).toFixed(2)}%`).join(', ') +
			')',
	);

	// Show ~5 tick labels (first, last, and 3 evenly-spaced in between).
	const ticks = $derived.by(() => {
		const n = ramp.stops.length;
		if (n <= 5) return ramp.stops.map((s, i) => ({ ...s, pos: positions[i] }));
		const indices = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1];
		return indices.map((i) => ({ ...ramp.stops[i], pos: positions[i] }));
	});

	const fmt = (v: number): string => {
		if (v === 0) return '0';
		if (Math.abs(v) >= 100) return v.toFixed(0);
		if (Math.abs(v) >= 10) return v.toFixed(1);
		if (Math.abs(v) >= 1) return v.toFixed(2);
		return v.toFixed(3);
	};
</script>

<div class="legend" role="img" aria-label="{title} color ramp">
	<p class="title">{title}</p>
	<div class="bar" style="background: {gradient};"></div>
	<div class="ticks">
		{#each ticks as t (t.value)}
			<span class="tick" style="left: {(t.pos * 100).toFixed(2)}%;">
				{fmt(t.value)}{ramp.unit}
			</span>
		{/each}
	</div>
</div>

<style>
	/* Indent matches the layer-card body (.year-row, .opacity-row, .desc all
	   sit at 1.5rem from the layer toggle's checkbox edge). Same left rail
	   leaves ~1rem on the right of the rail for the gradient to breathe.
	   `max-width: 100%` + `overflow: hidden` cap any tick that would push
	   past the rail's right edge — common with the 15-stop World Atlas
	   ramp's `mcd/m²` labels. */
	.legend {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.7rem;
		margin: 0.6rem 0 0 1.5rem;
		padding-right: 0.5rem;
		max-width: calc(100% - 2rem);
		overflow: hidden;
	}
	.title {
		margin: 0 0 0.4rem 0;
		font-size: 0.62rem;
		opacity: 0.5;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.bar {
		height: 0.55rem;
		border-radius: 2px;
		border: 1px solid rgba(255, 255, 255, 0.12);
	}
	/* The tick row gets a half-tick-width of inset on each side so the
	   first/last labels don't clip against the rail wall. */
	.ticks {
		position: relative;
		height: 1.1rem;
		margin-top: 0.3rem;
	}
	.tick {
		position: absolute;
		transform: translateX(-50%);
		opacity: 0.7;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		font-size: 0.62rem;
		/* Hard cap on a single tick's width so it can't push past the bar
		   when the label is long (e.g. "0.178mcd/m²" on the World Atlas
		   ramp). Browsers will truncate with ellipsis if needed. */
		max-width: 5.5rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tick:first-child {
		transform: translateX(0);
	}
	.tick:last-child {
		transform: translateX(-100%);
	}
</style>
