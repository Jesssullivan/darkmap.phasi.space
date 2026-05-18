<script lang="ts">
	/**
	 * TimeDock — NASA-Worldview-style monthly slider over the 169 VIIRS
	 * monthly composites (Apr 2012 → Apr 2026). Lives at the bottom of
	 * the viewport when the user enables monthly mode. Sub 4 will wire
	 * a parent component that swaps the active raster layer when the
	 * dock's month changes.
	 */

	import { VIIRS_MONTHLY_END, VIIRS_MONTHLY_START, VIIRS_MONTHS } from '$lib/layers';
	import type { MonthlyMonth } from '$lib/url-hash';

	interface Props {
		/** Currently-active month. */
		month: MonthlyMonth;
		/** True when autoplay is animating forward (parent owns the loop). */
		autoplay: boolean;
		onMonthChange: (m: MonthlyMonth) => void;
		onAutoplayChange: (a: boolean) => void;
		onClose?: () => void;
	}

	let { month, autoplay, onMonthChange, onAutoplayChange, onClose }: Props = $props();

	const TOTAL = VIIRS_MONTHS.length;

	const indexOf = (m: MonthlyMonth): number => {
		const target = m.year * 12 + (m.month - 1);
		for (let i = 0; i < VIIRS_MONTHS.length; i++) {
			const l = VIIRS_MONTHS[i];
			const k = (l.year ?? 0) * 12 + ((l.month ?? 1) - 1);
			if (k === target) return i;
		}
		return Math.max(0, Math.min(TOTAL - 1, target - (VIIRS_MONTHLY_START.year * 12 + VIIRS_MONTHLY_START.month - 1)));
	};

	const currentIndex = $derived(indexOf(month));

	const monthAt = (idx: number): MonthlyMonth => {
		const clamped = Math.max(0, Math.min(TOTAL - 1, idx));
		const l = VIIRS_MONTHS[clamped];
		return { year: l.year ?? VIIRS_MONTHLY_START.year, month: l.month ?? 1 };
	};

	const setIndex = (idx: number): void => {
		const next = monthAt(idx);
		if (next.year === month.year && next.month === month.month) return;
		onMonthChange(next);
	};

	const fmtMonth = (m: MonthlyMonth): string => {
		const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		return `${names[m.month - 1]} ${m.year}`;
	};

	// Year ticks every year, with labels on each year boundary.
	const yearTicks = $derived.by(() => {
		const out: { year: number; left: number }[] = [];
		for (let y = VIIRS_MONTHLY_START.year; y <= VIIRS_MONTHLY_END.year; y++) {
			const firstIdxOfYear = VIIRS_MONTHS.findIndex((l) => l.year === y);
			if (firstIdxOfYear < 0) continue;
			out.push({ year: y, left: firstIdxOfYear / Math.max(1, TOTAL - 1) });
		}
		return out;
	});

	// Autoplay loop lives in the parent (`+page.svelte`) so each tick
	// can `await` the layer swap before scheduling the next — at 700 ms
	// intervals with cold tile fetches the previous `setInterval` raced
	// the swap and stacked sources. TimeDock just calls
	// `onAutoplayChange(true|false)` and renders the play/pause state.

	const handleSlider = (ev: Event): void => {
		const value = Number((ev.target as HTMLInputElement).value);
		if (Number.isFinite(value)) setIndex(value);
	};

	const stepBy = (delta: number): void => {
		setIndex(currentIndex + delta);
	};

	const togglePlay = (): void => onAutoplayChange(!autoplay);

	const handleKey = (ev: KeyboardEvent): void => {
		if (ev.key === 'ArrowLeft') {
			ev.preventDefault();
			stepBy(ev.shiftKey ? -12 : -1);
		} else if (ev.key === 'ArrowRight') {
			ev.preventDefault();
			stepBy(ev.shiftKey ? 12 : 1);
		} else if (ev.key === ' ' || ev.key === 'Spacebar') {
			ev.preventDefault();
			togglePlay();
		}
	};
</script>

<div class="dock" aria-label="VIIRS monthly composite slider">
	<div class="row top">
		<button
			class="btn play"
			type="button"
			aria-label={autoplay ? 'Pause monthly autoplay' : 'Play monthly autoplay'}
			aria-pressed={autoplay}
			onclick={togglePlay}
		>
			{autoplay ? '⏸' : '▶'}
		</button>
		<button
			class="btn"
			type="button"
			aria-label="Previous month"
			onclick={() => stepBy(-1)}
			disabled={currentIndex <= 0}>←</button
		>
		<span class="label" aria-live="polite">{fmtMonth(month)}</span>
		<button
			class="btn"
			type="button"
			aria-label="Next month"
			onclick={() => stepBy(1)}
			disabled={currentIndex >= TOTAL - 1}>→</button
		>
		<span class="meta">VIIRS · {currentIndex + 1}/{TOTAL}</span>
		{#if onClose}
			<button class="btn close" type="button" aria-label="Close monthly slider" onclick={onClose}>✕</button>
		{/if}
	</div>
	<input
		class="slider"
		type="range"
		min="0"
		max={TOTAL - 1}
		step="1"
		value={currentIndex}
		aria-label="VIIRS month"
		aria-valuetext={fmtMonth(month)}
		oninput={handleSlider}
		onkeydown={handleKey}
	/>
	<div class="ticks" aria-hidden="true">
		{#each yearTicks as t (t.year)}
			<button
				type="button"
				class="year-tick"
				class:active={t.year === month.year}
				style="left: {(t.left * 100).toFixed(2)}%;"
				title="Jump to {t.year}"
				onclick={() => {
					const idx = VIIRS_MONTHS.findIndex((l) => l.year === t.year);
					if (idx >= 0) setIndex(idx);
				}}
			>
				{t.year}
			</button>
		{/each}
	</div>
</div>

<style>
	.dock {
		position: fixed;
		left: 1rem;
		right: 1rem;
		bottom: 1rem;
		background: rgba(8, 10, 16, 0.85);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 6px;
		padding: 0.55rem 0.75rem 0.85rem;
		color: #e9ecf3;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.72rem;
		z-index: 6;
		backdrop-filter: blur(6px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
	}
	.row.top {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.4rem;
	}
	.btn {
		background: transparent;
		color: inherit;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 999px;
		padding: 0.15rem 0.5rem;
		font: inherit;
		cursor: pointer;
	}
	.btn:hover:not(:disabled) {
		border-color: rgba(255, 209, 102, 0.6);
		color: #ffd166;
	}
	.btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.btn.play[aria-pressed='true'] {
		color: #ffd166;
		border-color: rgba(255, 209, 102, 0.6);
	}
	.btn.close {
		margin-left: 0.5rem;
	}
	.label {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		min-width: 6rem;
		text-align: center;
	}
	.meta {
		margin-left: auto;
		opacity: 0.55;
		font-size: 0.62rem;
	}
	.slider {
		display: block;
		width: 100%;
		margin: 0;
		accent-color: #ffd166;
	}
	.ticks {
		position: relative;
		height: 1rem;
		margin-top: 0.3rem;
	}
	.year-tick {
		position: absolute;
		transform: translateX(-50%);
		background: transparent;
		color: rgba(233, 236, 243, 0.5);
		border: none;
		padding: 0 0.25rem;
		font: inherit;
		font-size: 0.6rem;
		font-variant-numeric: tabular-nums;
		cursor: pointer;
	}
	.year-tick:hover {
		color: #ffd166;
	}
	.year-tick.active {
		color: #ffd166;
		font-weight: 700;
	}
	.year-tick:first-child {
		transform: translateX(0);
	}
	.year-tick:last-child {
		transform: translateX(-100%);
	}
</style>
