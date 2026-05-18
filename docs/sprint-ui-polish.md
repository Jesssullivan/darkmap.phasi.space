# Sprint: UI polish + ephemeris depth (2026-05-18 → next session)

The TIN-1298 / TIN-1301 / TIN-1302 cascades closed every original
master-plan ticket. The 5 GAP fixes shipped during triage landed the
infrastructure but exposed UX rough edges the operator noticed on the
live site. This sprint takes each feature from ~85 % done → 100 %.

## Order of attack

Land in this order so each PR's footprint doesn't crowd the next:

1. **GAP-10 — TimeDock autoplay race** *(svelte 5 wiring, smallest blast radius)*
2. **GAP-11 — Legend overflow inside LayerRail** *(CSS only)*
3. **GAP-12 — Bottom-right toggle stack collision** *(CSS + a small z-order pass)*
4. **GAP-13 — Skeleton 4.15.2 Tooltip / Popover adoption** *(consistent Zag primitives across readouts; replaces ad-hoc tooltips and div-as-pop-over patterns)*
5. **GAP-14 — Viewport bounds + horizon raycaster densification** *(actual point-at-azimuth dusk per the user's "lighthouse" vision)*

Cascades autonomously; each PR opens after the prior merges.

---

## GAP-10 — TimeDock autoplay race

**Problem.** `TimeDock.svelte`'s `$effect` installs a `setInterval`
(default 700 ms). Each tick calls `onMonthChange(nextMonth)`. The
parent's handler then runs `await mountMonthly(m)` which does
`swapMonthlyLayer(...)` — which `await`s the next MapLibre `'idle'`.
On a slow first-fetch month, the swap can take >700 ms, so the next
autoplay tick fires before the previous swap settles. Multiple new
sources stack up; old sources never get removed; the displayed
month appears stuck.

**Fix.** Move the autoplay loop from `TimeDock` into the parent
`+page.svelte`. Use a recursive `setTimeout` that:

1. Advances to `monthAt(currentIdx + 1)` in state.
2. `await mountMonthly(newMonth)` — pauses until the previous swap
   resolves.
3. Schedules the next tick.

`TimeDock` just calls `onAutoplayChange(true|false)`; it stops owning
the timer. This also makes pause-mid-tick deterministic — the loop
checks `monthlyAutoplay` before each schedule.

**Files**
- `src/lib/components/TimeDock.svelte` — drop `setInterval` $effect,
  drop `autoplayHandle`, drop `autoplayIntervalMs` prop.
- `src/routes/+page.svelte` — own a `monthlyAutoplayHandle:
  ReturnType<typeof setTimeout> | undefined`. On
  `onMonthlyAutoplayChange(true)` kick off the loop. On `(false)`
  `clearTimeout` it. Pull the interval into a const at top of file
  (700 ms keeps the existing UX).

**Acceptance**
- Click play, watch the slider step monthly with no stutter.
- Click pause mid-tick, slider stops at the current month (no
  trailing tick).
- Tile cache from `monthlyPrefetch` means each tick should resolve
  in <200 ms after the first.
- No vitest needed — UI race; smoke-tested manually + via the
  EphemerisGantt's per-viewport range pill not flickering.

**Effort.** 1 commit, ~30 lines net delta.

---

## GAP-11 — Legend overflow inside LayerRail

**Problem.** The `Legend.svelte` component sits inside each
`LayerRail` card body. The `.bar` gradient + tick row use the legend
container's full width. The container itself is the layer card body,
inset 1.5 rem from the rail's checkbox column. With long tick labels
(VIIRS has 14 stops; selected ticks 0/3/7/10/13) the last tick can
overflow the rail's right edge — visible as numbers clipping into the
rail's right padding.

**Root cause** in `Legend.svelte`:
- `.legend { padding-right: 0.5rem; }` is only a half-tick inset.
- `.tick:last-child { transform: translateX(-100%); }` clamps the
  text's right edge to the bar's right edge — but bar = container
  width = rail width minus inset. Long labels (`>0.10 mcd/m²`) still
  poke past on narrow rails.

**Fix.**
- Add `max-width: 100%` + `overflow: hidden` to `.legend`.
- Tighten tick rendering: each tick is `min-width: 0; max-width:
  fit-content` so the browser shrinks long labels.
- The bar gets a half-tick-width inset on left + right so the gradient
  visually starts where the first tick label centers.
- Optional follow-up: drop tick count to 3 (first / middle / last)
  when the rail is < 14 rem wide.

**Files**
- `src/lib/components/Legend.svelte` — CSS only.
- Possibly `src/lib/components/LayerRail.svelte` — verify the layer
  card body's right padding doesn't double-up.

**Acceptance**
- 14-stop VIIRS legend renders with no horizontal scroll inside the
  rail, no clipped tick labels at the rail's right edge.
- World Atlas (log-scale, 15 stops, units `mcd/m²`) renders the same.
- Snapshot smoke via the existing layer-rail flow.

**Effort.** 1 commit, CSS-only.

---

## GAP-12 — Bottom-right toggle stack collision

**Problem.** Three things compete for the bottom-right of the
viewport:
- `ephemeris-toggle` at `bottom: 0.75 rem; right: 0.75 rem`
- `monthly-toggle` at `bottom: 3.25 rem; right: 0.75 rem`
- `EphemerisGantt` spans `left: 1 rem; right: 1 rem; bottom: ?`
  (currently driven by `--gantt-bottom-rem`, defaults 1 rem, bumps
  to 6.5 rem when monthly is open)
- `TimeDock` at `left: 1 rem; right: 1 rem; bottom: 1 rem` when open

When both ephemeris + monthly are open, the gantt overlaps the
toggle buttons (gantt left/right span the whole viewport) and on
narrow viewports the dock + gantt + toggles all crash together.

**Fix.** Convert the toggle buttons into a *bottom tray* component
that owns its own z-order and pushes the gantt / dock up by its own
height:

- New `<MapToolbar />` component in the bottom-right corner; always
  visible. Stacks ⏱ + ☼/☾ vertically with `gap: 0.5 rem`.
- The tray sets `--toolbar-h-rem` on `:root` (or on a wrapping
  scope) so the gantt and dock can clear it.
- `EphemerisGantt` and `TimeDock` both gain `right: calc(toolbar-w +
  1.5 rem)` instead of `right: 1 rem`, so the toolbar sits to the
  right of them rather than under.
- The toolbar can collapse into a single "+" button on narrow
  viewports (mobile), expanding into the toggle set on tap.

**Files**
- New `src/lib/components/MapToolbar.svelte`.
- `src/routes/+page.svelte` — replace the inline `.ephemeris-toggle`
  / `.monthly-toggle` buttons with the toolbar.
- `src/lib/components/EphemerisGantt.svelte` — `.gantt right` uses a
  CSS var.
- `src/lib/components/TimeDock.svelte` — `.dock right` uses a CSS var.

**Acceptance**
- At desktop width with both overlays open: no element overlaps any
  other.
- At 375 px width: toolbar collapses to one button; tap expands.
- Tab order: search input → layer rail → map → toolbar → overlays
  (keyboard nav stays predictable).

**Effort.** 1 PR, 2 commits (component + wiring).

---

## GAP-13 — Skeleton 4.15.2 Tooltip / Popover adoption

**Problem.** Several readouts hold useful detail behind plain HTML
`title=""` attributes (no rich content, no styling, slow appearance
delay): the airmass chip, the per-body horizon-altitude tag, the
range pill, the moon-phase indicator, the geocoder score, the
layer-rail legend ticks, etc. The user is reading dense
spectroscopy-relevant numbers and the lack of progressive disclosure
hurts scanability.

**Fix.** Adopt `@skeletonlabs/skeleton-svelte`'s Tooltip + Popover
primitives (both Zag-backed) on every place we currently use
`title=""` for non-trivial content. Where the content is rich
(formula, link, conversion table) use Popover; where it's a
one-liner stay Tooltip.

**Targets, in order of value:**
1. **Airmass chip** → Popover with the Kasten-Young formula, a
   second-axis radiance scale, link to /docs#airmass.
2. **Horizon tag** → Popover with raycaster parameters (rays /
   distances / eye height) and "go to /docs#horizon-raycaster".
3. **Range pill** → Tooltip "Spread across 4×4 grid sampled in the
   viewport. Δ shrinks as you zoom in."
4. **Moon-phase indicator** → Tooltip with the actual angle (e.g.
   "waxing gibbous · phase 132°").
5. **Layer-rail legend ticks** → Tooltip with the exact pixel value
   at the tick (useful for Bortle / Falchi conversions).
6. **Geocoder hit score** → Tooltip "Photon rank-based score; 1.0 =
   top hit".

**Files**
- `src/lib/components/SkyCompass.svelte` — wraps airmass chip + sun /
  moon altitude tags in Popover triggers.
- `src/lib/components/EphemerisGantt.svelte` — wraps range pill +
  phase indicator in Tooltip triggers.
- `src/lib/components/Legend.svelte` — Tooltip on each tick.
- `src/lib/components/GeocoderSearch.svelte` — Tooltip on score
  badge.

**Acceptance**
- Hover (or focus) opens a styled, Skeleton-themed popup at the
  expected position (no overlap with the trigger).
- Touch: tap-to-open + tap-outside-to-close (Zag handles this).
- Popover content includes a "→ /docs#section" link so deep dives
  are one click away.
- A11y: `aria-describedby` wired automatically by the Zag primitive.

**Effort.** 1 PR, ~6 commits (one per readout target). Skeleton's
Tooltip + Popover have stable component slots; the lift is mostly
content writing + minor positioning.

---

## GAP-14 — Viewport bounds + horizon raycaster densification

**Problem.** The current horizon raycaster runs once per `(lat,
lon)` pin at 36 rays × 10 distance samples. For the user's
"lighthouse" vision — pick any point on the map and know the true
moment the sun crosses the local horizon at the sun's azimuth, with
all surrounding terrain accounted for — that's the right algorithm
but the wrong default density. At 36 rays the angular resolution is
10° per ray; the sun moves through ~15° of azimuth per hour, so the
interpolated horizon altitude can be off by ~½° at the sun's actual
azimuth.

Two layered fixes:

### GAP-14a — Adaptive ray density at the cursor's sun/moon azimuth

When computing horizon-aware event times (`refineEventSet`), the
sun's azimuth at the flat-horizon event time is known. Sample a
fine ray fan around that azimuth — say, 5 rays at ±2° around the
flat-horizon sun azimuth — instead of relying on the coarse 36-ray
interpolation.

This is local-density: the *whole* polygon stays cheap (36 rays for
the visualization) but the *event-time refinement* uses 5 extra rays
right where the sun is rising / setting.

### GAP-14b — Per-viewport horizon: pick a representative pin

Currently the SkyCompass + EphemerisGantt use the viewport center
as the observer. For wide viewports (state-scale), the center isn't
representative; a user looking at "Upstate NY" probably wants the
Adirondacks if they panned there. Two options:

1. **Per-pin readout**: click anywhere on the map → open a
   per-pin ephemeris panel using THAT lat/lon (not the viewport
   center).
2. **4-corner range** for event times: the range-pill already does
   this for the event time spread; extend it to the horizon
   polygon (per-corner polygon → per-event time pill).

The user's wording — "lighthouse / sun and moon overlay based on
the on screen view (taking into consideration elevation and on and
off screen elevation / hills etc)" — points at option 1: click a
point, get its true horizon. The 4-corner viewport-range stays for
the "across this viewport" Δ summary.

**Files (rough sketch)**
- `src/lib/ephemeris/HorizonProvider.ts` — add `polygonAtAzimuth(loc,
  azimuthDeg, opts)` returning a dense local fan around that
  azimuth. Used by `refineEventSet`.
- `src/lib/ephemeris/horizonAwareEvents.ts` — pass an azimuth-aware
  horizon resolver into the bisection callback so the local fan is
  used at the sun's current bearing.
- `src/routes/+page.svelte` — extend the existing `queryAt(lat,
  lon)` (point-readout panel) to ALSO mount a per-pin ephemeris
  panel.
- `src/lib/components/PointReadout.svelte` — add an "Ephemeris at
  this point" section that defers to a per-pin EphemerisClient call.
- `src/lib/components/SkyCompass.svelte` — gain a `pinnedLocation`
  prop; if set, use that instead of viewport center.

**Acceptance**
- Pin a point near a mountain → see horizon polygon distinctly
  taller in that bearing.
- Refined sunrise time at that pin is later than the flat-horizon
  sunrise by the mountain's angular elevation × ~4 min/° (sun
  motion).
- Sunrise time at the same pin re-using the cached polygon is
  instant.
- The viewport-center sky compass still works for the "current
  view" case.

**Effort.** This is the largest of the five. Break into:
- 14a: 2 commits (helper + wire into refineEventSet)
- 14b: 3 commits (point-readout ephemeris section, sky-compass
  pinned-location prop, page wiring)

Total ~5 PRs depending on review pace.

---

## Stretch / further follow-up

After the 5 above land, the remaining gap-analysis backlog reduces
to high-value-but-not-blocking items:

- **Moon-up-during-astro-darkness warning** in the gantt
- **Bortle / NELM** conversion in PointReadout (Falchi mcd/m² → NELM)
- **Bookmarks** via url-hash list codec
- **DMSP 1992-2013 legacy layers** (manifest only)
- **Astronomical-darkness iCal export** from the gantt
- **Color-blind palette toggle**

Each is roughly 1 PR.

Critical infra debt still open:
- ARC runner pod → cluster API routing (so CI auto-deploy works
  instead of requiring `just deploy` from a laptop)
- Image signing / cosign verify at admission
- Observability stack (Prometheus / Loki / dashboards)
