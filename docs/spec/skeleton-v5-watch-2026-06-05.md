# Skeleton v5 Watch & Upgrade Plan

Date: 2026-06-05

Linear: TIN-788 (M5.2). Parent: TIN-734 umbrella. Tracks the post-launch
upgrade path from Skeleton `4.15.2` (the M0–M4 baseline pinned by the
bootstrap spec) to Skeleton v5 once it reaches GA.

## Current Pin

- `@skeletonlabs/skeleton` exact `4.15.2`
- `@skeletonlabs/skeleton-svelte` exact `4.15.2`
- Tailwind `^4.2.4` via `@tailwindcss/vite`
- Local `skeletonTailwindV4Compat()` shim in `vite.config.ts` (rewrites
  `@variant`/`@apply variant-*` Skeleton CSS for Tailwind v4 stable)
- `@tummycrypt/vite-plugin-skeleton-colors` for color-pair generation

The bootstrap spec (`docs/spec/omux-website-bootstrap-2026-04-29.md`
§ Skeleton Baseline And v5 Watch) explicitly defers v5 because the npm
`latest` tag is v4 and the house QA track has not accepted v5.

## When To Upgrade

Trigger conditions, all of which must hold:

- Skeleton v5 ships a stable GA tag (not a `5.0.0-next.*` prerelease).
- 30-day soak in the Tailwind/Svelte ecosystem with no critical regressions
  reported on the Skeleton issue tracker.
- At least one other house repo (e.g. `pkgs.tinyland.dev`,
  `jesssullivan.github.io-vite8`) has migrated and is green in production.
- Tinyland's separate v5 QA work has accepted the theme/component surface.

Until those gates clear, this site stays on v4.15.2.

## Estimated Tax

12–16 hours of focused work, structured as:

- 2–3h: read the v5 migration guide; diff the official changelog against the
  surface omux actually uses (AppBar, Avatar, Tabs, Tooltip, Switch, Toast,
  Popover, Dialog, Navigation).
- 3–4h: theme file rewrite. Skeleton v5 changes the theme format; the
  current `src/lib/styles/themes/omux.css` 11-shade ramps need
  re-expression. Validate Warm/Pragmatic OKLCH anchors are preserved.
- 2–3h: component API delta. Update every `@skeletonlabs/skeleton-svelte`
  import site to the v5 component contract.
- 2–3h: `@variant` migration. With v5 the local `skeletonTailwindV4Compat()`
  shim in `vite.config.ts` should be deletable; verify and remove.
- 1–2h: visual diff against M2.5 baseline screenshots; fix regressions.
- 1h: CHANGELOG, version bump, PR.

## Migration Scope

- `vite.config.ts`: remove `skeletonTailwindV4Compat()` if the v5 CSS no
  longer emits the rewritten syntax. Keep `@tummycrypt/vite-plugin-skeleton-colors`
  if it still applies; otherwise replace with v5-native equivalent.
- `src/lib/styles/themes/omux.css`: rewrite to the v5 theme format. Preserve
  primary/secondary/tertiary/surface OKLCH anchors verbatim.
- All `@skeletonlabs/skeleton-svelte` import sites under `src/lib/components/`
  and `src/routes/`. Track via `git grep '@skeletonlabs/skeleton-svelte'`.
- `package.json`: bump both Skeleton packages to the v5 GA tag (still
  exact-pinned per house policy).
- `pnpm-lock.yaml`: regenerate.

## Test Plan

- `just check` clean (lint + typecheck + unit).
- `just build` produces `build/` with no plugin errors.
- Component smoke: home route renders every Skeleton component used by the site
  and any future deliberate component smoke route owned by the scaffold.
- Visual diff: capture screenshots of `/` and the deliberate component smoke
  route once it exists, then diff against the M2.5 baseline screenshots
  archived at the close of M2. Tolerance: pixel-equivalent within
  anti-aliasing noise.
- Lighthouse re-run: a11y >= 95, performance/best-practices/SEO >= 90.
- Manual: light/dark toggle, mobile viewport, no console errors.

If any gate fails, the upgrade rolls back to v4.15.2 and the watch ticket
stays open.
