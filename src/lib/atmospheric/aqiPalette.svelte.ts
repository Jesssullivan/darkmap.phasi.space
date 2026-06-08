import { browser } from '$app/environment';
import type { PaletteMode } from './aqi';

/**
 * AQI palette rune store (TIN-1771). Mirrors `src/lib/theme.svelte.ts` /
 * `src/lib/lens.svelte.ts`: a single reactive source of truth the AQI render
 * surfaces (PM2.5 dot ramp, AQ dashboard, categories) `$derive` from.
 *
 * The mode is a DISPLAY option only — `'colorvision'` recolors the same six EPA
 * categories with a deuteranopia/protanopia-distinguishable ramp; it never
 * reclassifies the data or relabels a reading. Default `'airnow'` keeps the
 * canonical EPA green→maroon ramp. Persisted under `darkmap-aqi-palette`
 * (remember-last); only an explicit `set`/`toggle` persists.
 *
 * NO testable pure logic lives here — rune stores are not enrolled in the
 * bazel atmospheric vitest slice. All contrast/CVD math stays in `aqi.ts`.
 */
const STORAGE_KEY = 'darkmap-aqi-palette';
const DEFAULT_MODE: PaletteMode = 'airnow';

const isPaletteMode = (v: unknown): v is PaletteMode => v === 'airnow' || v === 'colorvision';

class AqiPaletteStore {
	mode = $state<PaletteMode>(DEFAULT_MODE);

	/** Resolve the initial palette from localStorage (remember-last); else default. Does not persist. */
	init() {
		if (!browser) return;
		const stored = localStorage.getItem(STORAGE_KEY);
		if (isPaletteMode(stored)) this.mode = stored;
	}

	/** Explicit user choice — updates state + persists remember-last. */
	set(mode: PaletteMode) {
		if (this.mode === mode) return;
		this.mode = mode;
		if (browser) {
			if (mode === DEFAULT_MODE) localStorage.removeItem(STORAGE_KEY);
			else localStorage.setItem(STORAGE_KEY, mode);
		}
	}

	/** Flip between the two palettes (the toolbar toggle). */
	toggle() {
		this.set(this.mode === 'airnow' ? 'colorvision' : 'airnow');
	}
}

export const aqiPalette = new AqiPaletteStore();
