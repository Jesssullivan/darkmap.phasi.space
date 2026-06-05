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
 * assistive tech. Phrasing tracks what each lens leads with (see the `lead`
 * cells in READOUT_RELEVANCE, src/lib/readoutRelevance.ts); keep them in lockstep.
 */
export const LENS_ANNOUNCE: Record<Lens, string> = {
	sky: 'Sky lens — leading with dark-sky brightness and ephemeris',
	air: 'Air lens — leading with air quality and atmosphere',
	links: 'Links lens — leading with atmospheric transmission',
	orbit: 'Orbit lens — leading with ephemeris and terrain',
};

/**
 * Per-lens accent (W5c) — the one warm-highlight colour each lens claims for its
 * three identity surfaces: the active LensSwitcher chip, the inspector lead value,
 * and the leading TOOLS launcher. Sky keeps the historical amber (= --accent-amber);
 * Air/Links/Orbit each get a distinct hue so a colour-vision-typical eye can tell
 * the active lens at a glance — never colour ALONE (the chip also fills + bolds).
 *
 * All four clear WCAG AA both as text on the near-black deck (amber 14.0 : 1,
 * green 11.7, blue 9.4, violet 9.9) and as a fill behind #0a0a0a chip text.
 * CSS mirrors these as `--lens-accent` on `.command-deck[data-lens]`
 * (src/app.css + +page.svelte) — keep the two in lockstep.
 */
export const LENS_ACCENT: Record<Lens, string> = {
	sky: '#FFD166',
	air: '#4ADE80',
	links: '#6BB6FF',
	orbit: '#C4A6FF',
};
