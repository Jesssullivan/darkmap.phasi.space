import { browser } from '$app/environment';
import { DEFAULT_LENS, isLens, type Lens } from './lens';

/**
 * Persona-lens rune store (S1). Mirrors `src/lib/theme.svelte.ts`: a single
 * reactive source of truth the five map surfaces `$derive` from. The map's
 * own state (center/zoom/marker/time) is orthogonal — a lens flip re-weights
 * framing only, never the canvas.
 *
 * Resolution order on load: URL hash (shareable) wins → localStorage
 * (remember-last) → DEFAULT_LENS. A shared `&lens=` link sets the active lens
 * WITHOUT clobbering the user's sticky preference; only an explicit switch
 * (`set`) persists.
 */
class LensStore {
	lens = $state<Lens>(DEFAULT_LENS);

	/** Resolve the initial lens. `hashLens` (from decodeHash) wins; else localStorage; else default. Does not persist. */
	init(hashLens?: Lens | null) {
		if (isLens(hashLens)) {
			this.lens = hashLens;
			return;
		}
		if (!browser) return;
		const stored = localStorage.getItem('darkmap-lens');
		if (isLens(stored)) this.lens = stored;
	}

	/** Explicit user switch — updates state + persists remember-last. */
	set(lens: Lens) {
		if (this.lens === lens) return;
		this.lens = lens;
		if (browser) {
			if (lens === DEFAULT_LENS) localStorage.removeItem('darkmap-lens');
			else localStorage.setItem('darkmap-lens', lens);
		}
	}
}

export const lensStore = new LensStore();
