/**
 * Persona lens — the audience "mode" that re-weights (never gates) the map's
 * derived surfaces (LayerRail / PointReadout / primary CTA / MapToolbar /
 * basemap default). Pure type + guards here so `url-hash.ts` and tests can
 * depend on them without pulling in the rune store (`lens.svelte.ts`).
 *
 * S1 (lens nav engine) of the power-tool-exposure epic. See
 * docs/ux/personas-and-lenses.md §3 + §11.
 */

export type Lens = 'sky' | 'air' | 'links' | 'orbit';

/** All lenses in switcher order. */
export const LENSES = ['sky', 'air', 'links', 'orbit'] as const;

/** Default when no hash / no stored preference (the historical map = Sky). */
export const DEFAULT_LENS: Lens = 'sky';

/** Narrowing guard for untrusted input (hash value, localStorage, key map). */
export const isLens = (v: unknown): v is Lens => typeof v === 'string' && (LENSES as readonly string[]).includes(v);

/**
 * Screen-reader announcement per lens (S1 polish) — spoken via a polite
 * `aria-live` region when the lens changes, so the re-weight isn't silent to
 * assistive tech. Phrasing tracks what each lens leads with (see LENS_LEAD in
 * PointReadout); keep them in lockstep.
 */
export const LENS_ANNOUNCE: Record<Lens, string> = {
	sky: 'Sky lens — leading with dark-sky brightness and ephemeris',
	air: 'Air lens — leading with air quality and atmosphere',
	links: 'Links lens — leading with atmospheric transmission',
	orbit: 'Orbit lens — leading with ephemeris and terrain',
};
