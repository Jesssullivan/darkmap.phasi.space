<script lang="ts">
	/**
	 * TimeDock — bottom-of-screen dock for the VIIRS monthly-trend slider
	 * (TIN-1301 / [Epic] C5, subtask 3). NASA Worldview / Windy convention:
	 * full-width, dark glass, ~64px tall.
	 *
	 * Deliberately stateless: the parent route owns `month` / `playing` /
	 * `speed` (driving both the MapLibre source-swap engine and the URL
	 * hash) and this component only ever proposes changes via `onChange`.
	 * That keeps the source-swap engine (subtask 4, not yet wired) and the
	 * `t=`/`p=` hash codec as the two things actually mutating state, and
	 * TimeDock a pure control surface — easy to drive from Playwright and
	 * easy to keep in sync with the URL without a second source of truth.
	 *
	 * Keyboard a11y: this is a `role="slider"` over discrete month steps,
	 * not an `<input type="range">` — plain range inputs fight map-zoom on
	 * trackpads if anything nearby also binds wheel events (the epic's
	 * anti-pattern list is explicit: don't bind the slider to wheel events
	 * at all). Left/Right step ±1 month; Shift+Left/Right step ±12.
	 */

	export type PlaybackSpeed = 1 | 4 | 12;

	export interface TimeDockChange {
		readonly month: string;
		readonly playing: boolean;
		readonly speed: PlaybackSpeed;
	}

	interface Props {
		/** Chronological (ascending) month keys, e.g. `VIIRS_MONTHLY_LAYERS.map(l => l.month)`. */
		months: readonly string[];
		/** Currently displayed month. Must be a member of `months`. */
		month: string;
		playing: boolean;
		speed: PlaybackSpeed;
		onChange: (next: TimeDockChange) => void;
		/** Dock visibility — parent owns the "Monthly trends" chip toggle. */
		open?: boolean;
	}

	let { months, month, playing, speed, onChange, open = true }: Props = $props();

	const SPEEDS: readonly PlaybackSpeed[] = [1, 4, 12];

	const indexOf = (m: string): number => {
		const i = months.indexOf(m);
		return i < 0 ? 0 : i;
	};

	const clampIndex = (i: number): number => Math.min(months.length - 1, Math.max(0, i));

	const formatMonth = (m: string): string => {
		const [y, mo] = m.split('-').map(Number);
		if (!y || !mo) return m;
		// UTC noon avoids local-timezone month rollback near midnight.
		const d = new Date(Date.UTC(y, mo - 1, 1, 12));
		return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', timeZone: 'UTC' });
	};

	function stepTo(index: number) {
		const clamped = clampIndex(index);
		const next = months[clamped];
		if (next === undefined || next === month) return;
		onChange({ month: next, playing, speed });
	}

	function step(delta: number) {
		stepTo(indexOf(month) + delta);
	}

	function togglePlay() {
		onChange({ month, playing: !playing, speed });
	}

	function setSpeed(next: PlaybackSpeed) {
		if (next === speed) return;
		onChange({ month, playing, speed: next });
	}

	function handleTrackClick(e: MouseEvent, track: HTMLElement) {
		const rect = track.getBoundingClientRect();
		if (rect.width <= 0) return;
		const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
		stepTo(Math.round(frac * (months.length - 1)));
	}

	function handleKeydown(e: KeyboardEvent) {
		switch (e.key) {
			case 'ArrowLeft':
				e.preventDefault();
				step(e.shiftKey ? -12 : -1);
				break;
			case 'ArrowRight':
				e.preventDefault();
				step(e.shiftKey ? 12 : 1);
				break;
			case 'Home':
				e.preventDefault();
				stepTo(0);
				break;
			case 'End':
				e.preventDefault();
				stepTo(months.length - 1);
				break;
			case ' ':
			case 'Spacebar':
				e.preventDefault();
				togglePlay();
				break;
		}
	}

	const currentIndex = $derived(indexOf(month));
	const fraction = $derived(months.length > 1 ? currentIndex / (months.length - 1) : 0);
</script>

{#if open && months.length > 0}
	<div class="time-dock" role="group" aria-label="VIIRS monthly time-trend controls">
		<button
			type="button"
			class="play"
			aria-label={playing ? 'Pause playback' : 'Play monthly trend'}
			aria-pressed={playing}
			onclick={togglePlay}
		>
			{playing ? '⏸' : '▶'}
		</button>

		<button
			type="button"
			class="step"
			aria-label="Previous month"
			disabled={currentIndex <= 0}
			onclick={() => step(-1)}
		>
			◀
		</button>

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="track"
			role="slider"
			tabindex="0"
			aria-label="Month"
			aria-valuemin={0}
			aria-valuemax={months.length - 1}
			aria-valuenow={currentIndex}
			aria-valuetext={formatMonth(month)}
			onkeydown={handleKeydown}
			onclick={(e) => handleTrackClick(e, e.currentTarget)}
		>
			<div class="track-fill" style="width: {(fraction * 100).toFixed(2)}%;" aria-hidden="true"></div>
			<div class="cursor" style="left: {(fraction * 100).toFixed(2)}%;" aria-hidden="true"></div>
		</div>

		<button
			type="button"
			class="step"
			aria-label="Next month"
			disabled={currentIndex >= months.length - 1}
			onclick={() => step(1)}
		>
			▶
		</button>

		<span class="readout" aria-live="polite">Currently showing: {formatMonth(month)}</span>

		<div class="speeds" role="group" aria-label="Playback speed">
			{#each SPEEDS as s (s)}
				<button
					type="button"
					class="speed-pill"
					class:active={speed === s}
					aria-pressed={speed === s}
					aria-label="{s}x speed"
					onclick={() => setSpeed(s)}
				>
					{s}×
				</button>
			{/each}
		</div>
	</div>
{/if}

<style>
	.time-dock {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 9;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		height: 64px;
		padding: 0 1rem;
		padding-bottom: env(safe-area-inset-bottom, 0);
		background: rgba(12, 14, 20, 0.82);
		backdrop-filter: blur(10px);
		border-top: 1px solid rgba(255, 255, 255, 0.12);
		color: #eef0f4;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.8rem;
	}

	.play,
	.step {
		flex: 0 0 auto;
		background: rgba(255, 255, 255, 0.08);
		color: inherit;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 6px;
		width: 2.1rem;
		height: 2.1rem;
		font-size: 0.95rem;
		cursor: pointer;
	}
	.play:hover,
	.step:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.16);
	}
	.step:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.track {
		position: relative;
		flex: 1 1 auto;
		height: 6px;
		min-width: 8rem;
		background: rgba(255, 255, 255, 0.14);
		border-radius: 999px;
		cursor: pointer;
		outline-offset: 4px;
	}
	.track-fill {
		position: absolute;
		inset: 0 auto 0 0;
		background: rgba(120, 170, 255, 0.85);
		border-radius: 999px;
	}
	.cursor {
		position: absolute;
		top: 50%;
		width: 14px;
		height: 14px;
		margin-left: -7px;
		transform: translateY(-50%);
		background: #fff;
		border-radius: 50%;
		box-shadow: 0 0 0 2px rgba(120, 170, 255, 0.85);
	}

	.readout {
		flex: 0 0 auto;
		white-space: nowrap;
		min-width: 11rem;
	}

	.speeds {
		flex: 0 0 auto;
		display: flex;
		gap: 0.3rem;
	}
	.speed-pill {
		background: rgba(255, 255, 255, 0.08);
		color: inherit;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 999px;
		padding: 0.25rem 0.55rem;
		font: inherit;
		cursor: pointer;
	}
	.speed-pill.active {
		background: rgba(120, 170, 255, 0.85);
		color: #0b0d12;
		border-color: transparent;
		font-weight: 600;
	}

	@media (max-width: 640px) {
		.readout {
			display: none;
		}
	}
</style>
