<script lang="ts">
	/**
	 * TimeSeriesChart — a small, dependency-free SVG line chart for the AQ
	 * dashboard (V6-4). Pure-presentational: it draws exactly the samples it is
	 * given and nothing else.
	 *
	 * Honesty (the whole point):
	 *   • x is positioned by real timestamp, not sample index — a sparse stretch
	 *     reads as a wider gap, not evenly-spaced "data".
	 *   • the line BREAKS across a real gap (a delta larger than `gapFactor`× the
	 *     median spacing) instead of drawing a diagonal that implies continuity
	 *     across hours the sensor never reported. Missing hours stay missing.
	 *   • fewer than two points renders dots only (a single reading is not a trend).
	 *
	 * The window label + sample count live in the parent panel, not here.
	 */

	import { median } from '$lib/atmospheric/stats';

	interface ChartPoint {
		/** ISO-8601 timestamp. */
		readonly at: string;
		readonly value: number;
	}

	interface Props {
		points: readonly ChartPoint[];
		units?: string | null;
		ariaLabel?: string;
		/** Drawing height in px (width is responsive via viewBox). */
		height?: number;
		/** Break the line when a gap exceeds this multiple of the median spacing. */
		gapFactor?: number;
	}

	let { points, units = null, ariaLabel = 'Time series', height = 132, gapFactor = 1.8 }: Props = $props();

	const W = 320;
	const PAD_X = 6;
	const PAD_Y = 8;
	// Reserve a little left gutter for the y-axis min/max labels.
	const GUTTER = 30;

	interface Plotted {
		readonly x: number;
		readonly y: number;
		readonly at: number;
		readonly value: number;
	}

	const view = $derived.by(() => {
		const H = height;
		const valid = points
			.filter((p) => Number.isFinite(p.value) && !Number.isNaN(Date.parse(p.at)))
			.map((p) => ({ at: Date.parse(p.at), value: p.value }))
			.sort((a, b) => a.at - b.at);
		if (valid.length === 0) {
			return { plotted: [] as Plotted[], segments: [] as string[], yMin: 0, yMax: 0, H };
		}
		// `valid` is sorted ascending by `at`, so the x-extent is just the ends.
		const xMin = valid[0].at;
		const xMax = valid[valid.length - 1].at;
		let yMin = valid[0].value;
		let yMax = valid[0].value;
		for (const p of valid) {
			if (p.value < yMin) yMin = p.value;
			if (p.value > yMax) yMax = p.value;
		}
		if (yMin === yMax) {
			// Flat series: give it a sane band so the line sits mid-height.
			yMin = yMin > 0 ? 0 : yMin - 1;
			yMax = yMax + (yMax === 0 ? 1 : Math.abs(yMax) * 0.25);
		}
		const xSpan = xMax - xMin || 1;
		const ySpan = yMax - yMin || 1;
		const innerW = W - GUTTER - PAD_X;
		const innerH = H - PAD_Y * 2;
		const plotted: Plotted[] = valid.map((p) => ({
			at: p.at,
			value: p.value,
			x: GUTTER + ((p.at - xMin) / xSpan) * innerW,
			y: PAD_Y + (1 - (p.value - yMin) / ySpan) * innerH,
		}));

		// Median spacing → break the path across real gaps (missing hours).
		const deltas = plotted.slice(1).map((p, i) => p.at - plotted[i].at);
		const medianDelta = deltas.length ? median(deltas) : 0;
		const breakAt = medianDelta > 0 ? medianDelta * gapFactor : Infinity;

		const segments: string[] = [];
		let run: Plotted[] = [];
		const flush = (): void => {
			if (run.length >= 2) {
				segments.push(run.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
			}
			run = [];
		};
		for (let i = 0; i < plotted.length; i++) {
			if (i > 0 && plotted[i].at - plotted[i - 1].at > breakAt) flush();
			run.push(plotted[i]);
		}
		flush();

		return { plotted, segments, yMin, yMax, H };
	});

	const fmtVal = (v: number): string => (Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v).toString());
</script>

{#if view.plotted.length === 0}
	<p class="empty">No samples to plot.</p>
{:else}
	<svg
		class="chart"
		viewBox={`0 0 ${W} ${view.H}`}
		preserveAspectRatio="none"
		role="img"
		aria-label={`${ariaLabel}: ${view.plotted.length} samples, ${fmtVal(view.yMin)} to ${fmtVal(view.yMax)} ${units ?? ''}`}
	>
		<!-- y-axis min/max guides -->
		<line class="axis" x1={GUTTER} y1={PAD_Y} x2={W - PAD_X} y2={PAD_Y} />
		<line class="axis" x1={GUTTER} y1={view.H - PAD_Y} x2={W - PAD_X} y2={view.H - PAD_Y} />
		<text class="axis-label" x={GUTTER - 4} y={PAD_Y + 3} text-anchor="end">{fmtVal(view.yMax)}</text>
		<text class="axis-label" x={GUTTER - 4} y={view.H - PAD_Y} text-anchor="end">{fmtVal(view.yMin)}</text>

		{#each view.segments as d (d)}
			<path class="line" {d} />
		{/each}
		{#each view.plotted as p (p.at)}
			<circle class="dot" cx={p.x} cy={p.y} r="1.4" />
		{/each}
	</svg>
{/if}

<style>
	.chart {
		width: 100%;
		height: auto;
		display: block;
		overflow: visible;
	}
	.line {
		fill: none;
		stroke: var(--accent-amber);
		stroke-width: 1.4;
		stroke-linejoin: round;
		stroke-linecap: round;
		vector-effect: non-scaling-stroke;
	}
	.dot {
		fill: var(--accent-amber);
	}
	.axis {
		stroke: light-dark(rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.12));
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}
	.axis-label {
		fill: light-dark(rgba(0, 0, 0, 0.55), rgba(233, 236, 243, 0.55));
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 9px;
	}
	.empty {
		margin: 0;
		font-size: 0.78rem;
		opacity: 0.6;
	}
</style>
