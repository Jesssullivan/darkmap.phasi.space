# darkmap — the Command Deck (UI redesign north-star)

> One MapLibre canvas inside a single CSS-Grid app shell of named,
> non-overlapping regions. The lens re-weights by **order + grouping + size +
> accent-label** — **never** opacity/disable. Every deep tool has a persistent
> in-layout launcher and inherits the click as its query.

Status: **shipped and live**. The redesign landed in waves — de-dim, the grid shell,
the Instrument Bay (toolbar + deep-tools relocation), the full responsive reflow, and
the polish pass (per-lens accents, Cmd-K, container queries) — replacing the old
float-soup (14 `position:fixed` surfaces + the z4→z13 ladder) with the named-region
grid. This doc is now the reference for the as-built design contract, not a plan.

## 1. Why (the problem this fixes)

An operator review of the live site found it "wildly broken": stacked/overlapping
pop-out panels at most breakpoints, features "greyed out … only activatable if you
know which order of clicks to click", components obscuring the twilight strip, no
dashboard hierarchy. The audit confirmed six root failures:

1. **Tier-3 dim reads as disabled** — the lens dimmed off-lens content to
   ~0.55–0.6 opacity (the majority of readout sections + whole rail groups +
   instrument tiles), the universal "disabled control" signal. _(Fixed in W0.)_
2. **Deep-tool sheets paint over the twilight gantt** (`bottom:0; z12` sheets vs
   the `z6` gantt, with no rule lifting the gantt).
3. **The mobile layer drawer (88vw, full-height) hides the entire map**, with the
   guided Tour stacked on top of it.
4. **Click-order trap** — the deep tools were stripped of every independent entry
   point and re-homed inside the readout, reachable only via
   map-click → readout → CTA → sheet.
5. **No layout owner** — `.field-hud{pointer-events:none}` is a click-through
   scrim, not a grid; the "portal" bolted on *more* fixed cards.
6. **Five fighting breakpoint families** (821×501 / 820 / 640 / 560 / portrait)
   with only one "structured" desktop band; everything else free-floats.

Root cause: **everything is `position:fixed` at a viewport corner** (14 surfaces,
a z4→z13 ladder) — collision is the default. And **emphasis was expressed by
suppression** (dimming), which is indistinguishable from disabling.

## 2. North-star: the Command Deck

One grid shell (`.command-deck`) replaces `.field-hud` + all 14 floats + the
z-ladder. **Overlap becomes impossible by construction** — two grid *areas* can
never occupy the same pixels — so the twilight strip + map can only be *shrunk*,
never occluded, at every breakpoint.

### Regions

- **Lens switcher + search** (stage overlays — the HEADER row was reclaimed): originally
  a reserved HEADER row; **X2 (#405) deleted that row** and re-homed both onto the STAGE
  as map overlays — the LensSwitcher pinned top-**right**, the compact GeocoderSearch
  top-**left** (P6 #413 height-normalizes the search and, at COMPACT, docks the switcher
  into the bottom sheet as a full-width lens strip). The active chip takes the lens accent
  (filled pill + bold label, ColorVision-Assist — never color-alone). Number-keys 1–4 stay.
- **RAIL** (left, ~20rem): the layer accordions by data family (Night-lights /
  Atmosphere / Terrain / Ephemeris, multi-expand, provenance chip on every header
  even collapsed) + the instrument tiles + the persistent **TOOLS** cluster (all
  four deep-tool launchers). Collapses to a ~4.5rem icon nav-rail that **pushes**
  the stage (never overlays).
- **STAGE** (center, `1fr`, min ~300px): the MapLibre canvas as `grid-area:stage`
  — no `position:fixed`, no inset. The sci-fi frame becomes the stage cell's
  *border*, not a z4 overlay. The grid sizes the map; regions shrink it, never
  cover it. `--stage-inset-*` feeds MapLibre `fitBounds` padding; `trackResize` on.
- **INSPECTOR** (right, ~22rem): the PointReadout as a **persistent docked column**
  (already mounted in "mean" scope). Scan order: lens-accented header → **large
  lead value** → support sections (full weight) → "More — N sections ▾"
  (collapsed-but-obvious, full contrast) → TOOLS. Deep tools open **inside this
  column** (master-detail) or shrink the stage — never as a `bottom:0 z12` sheet.
- **DOCK** (bottom, full width): the time helix (the twilight strip — `TimeHelix.svelte`, née the twilight gantt; the row keeps its `.gantt` smoke contract) as its **own reserved row** at
  every breakpoint — so "X floats over the twilight strip" is structurally
  impossible. Deletes the ~120 lines of `--field-panel-*` math + `!important`
  overrides + the portrait clearance special-case.

The PR5 `--portal-inset-*` tokens were a half-right faux-grid (insetting the map at
one breakpoint); **promote them into real grid tracks** and delete the inset tokens.

## 3. Responsive — same DOM, reflow by `grid-template-areas`

Never reposition, never `display:none` a feature. Container queries drive each
region's own density (roomy vs icon-compact). Three coordinated layouts replace the
five fighting families:

- **WIDE (≥1024px):** `'rail stage inspector' / 'dock dock dock'` (the HEADER row was reclaimed in X2 — lens + search are stage overlays). Two sub-bands: laptop 1024–1365px `[19rem][1fr][22rem]`, roomy ≥1366px `[22rem][minmax(380px,1fr)][30rem]`. Persistent rail + inspector; deep tools dock in the inspector (stage shrinks, never covered).
- **MEDIUM (640–1023px):** `'rail stage' / 'dock dock'`. Rail → icon nav-rail that pushes the stage on expand; inspector is a collapsible that re-adds its column when opened (stage shrinks, never floats).
- **COMPACT (<640px):** single column `'stage' / 'dock'` (the deck falls back to `display:contents`; lens + search + toolbar are stage overlays). Rail + inspector + tools collapse into **one** non-modal bottom-sheet (Material 3 standard, co-exists with the map) with PEEK / HALF / FULL(~88%, never 100% — a map strip always shows) detents. Switching layers→readout→tool **swaps the sheet content**, never spawns a second panel — killing the "390px Tour-over-fullscreen-rail-over-hidden-map" bug. The gantt is a thin always-present row *above* the sheet's peek.

Verify the non-overlap invariant with the SwiftShader camera at 390/640/768/1024/1440: no region's box intersects the map's except by shrinking it; the gantt's box never intersects any other region.

## 4. The lens, reframed — promote, never dim

Delete opacity-dim entirely. A lens uses **exactly four** non-destructive
mechanisms and may never touch opacity / weight-down / color-to-grey /
`aria-disabled` / `pointer-events` / `display`:

1. **Order** — lead sections sort to the top; off-lens keep full strength and sort below (`Relevance` is `{lead, support, more}`; "more" routes to the collapsed group, _shipped in W0_).
2. **Grouping** — each region splits into an expanded "[Lens] — your tools" group and one collapsed-but-obvious "More — Air quality, Pollen, History (3) ▾" accordion (full-contrast, one click). Progressive disclosure (reachable + legible) — the opposite of dimming.
3. **Size/typography** — the lead value renders larger (the existing Bortle headline, extended per lens); others use the shared body size. Emphasis = lead bigger, never others smaller/fainter.
4. **Color-coded + labeled headers** — one per-lens accent (Sky amber / Air AQI-band / Links signal-blue / Orbit violet) on the active region header + chip only, always paired with a text label. Off-lens headers stay neutral ink at full opacity.

**Default-expanded-active / collapsed-but-obvious-others** is the keystone. All four
deep-tool launchers render at full strength as a persistent TOOLS cluster; the lens
only bolds + orders the matching one first (the `ctaTier→3` ghost is deleted).

## 5. Click reduction — per-persona ≤N to the answer

The inspector is the single details surface; the TOOLS cluster is always on
(launchers open seeded-empty, fill on point-select — kill the "meaningless without
a point" gating). **Carry-the-query:** map-click pre-fills the readout; the CTA
pre-fills the deep tool with `{lat,lon,et,lens,layers,boresight,horizon}` with zero
re-entry. Hover-to-**peek** (ephemeral), click-to-**pin** (commit + enable CTAs);
value + its one CTA share one large target (Fitts).

- ◐ **Sky** "dark window here" — **≤1 click** (hover=0): inspector leads Bortle + tonight's dark-window inline; the full time helix always in the DOCK.
- ☁ **Air** "AQI here" — **≤1 click**: smog field present on Air-lens entry; inspector leads driving pollutant + NowCast-labeled AQI; AQ summary docked in-inspector.
- 📡 **Links** "link margin" — **≤2 clicks**: click → path-AOD→T→dB line; "Design a link" → boresight + Tx/Rx + loss breakdown expand *into* the inspector.
- 🛰 **Orbit** "next pass" — **≤2 clicks**: next DEM-gated pass on pin regardless of lens; "Plan a pass" → polar az/el track + pass list expand in-inspector.

`closeReadout()` must not force-close a deep tool. Cmd-K **shipped in W5** (#401 — a fuzzy
command palette); number-keys 1–4 + the T/P/A accelerators + inline shortcut hints stay.

## 6. Rebuild waves

- **W0 — de-dim** ✅ (#380): delete the Tier-3 tokens + every dim usage; `Relevance` → `{lead,support,more}`; smoke enforces `opacity===1`. No layout change.
- **W1 — grid shell** ✅ (#382): `.command-deck` 5-region grid at WIDE; `.map`→`grid-area:stage`; lens+geocoder→HEADER, gantt→DOCK (one gantt, not two); de-duped the standalone SkyCompass float (the dome now lives only in the rail). Camera-verified WIDE zero-overlap, all four lenses. **Fontless-cell peg fix:** the grid pegged the RBE cell's main thread before DCL until `min-width:0` on the header flex children (+ `minmax(0,…)` rows) made layout metric-independent — see [[reference_darkmap_ci_testing]].
- **W2 — inspector + two-group readout + always-on TOOLS** ✅ (#383 map-shrink + ToolsCluster, #384 two-group readout, #385 toolbar re-home): dock PointReadout; "[Lens] — your tools" + "More (N) ▾"; large lead per lens; kill the data-guarded CTA gating.
- **W3 — deep tools dock in-region** ✅ (#386): TransmissionSheet/PassPlan/AQ render inside the inspector (master-detail / stage-shrink); wire carry-the-query; delete the `bottom:0 z12` sheet.
- **W4 — responsive reflow + container queries** ✅ (#389–393): MEDIUM + COMPACT; re-anchor the Tour to grid cells; delete the `!important` block + every `display:none` feature drop. Camera-verify 390/640/768/1024/1440.
- **W5 — polish** ✅ (#399–403): per-lens accents (label-paired), shortcut hints, update personas §11.3 to "promote/group/size/label — never dim".
- **X1/X2 — Air viewport-instrument live-fetch + HEADER reclaim** ✅ (#404/#405); **P6 — iPhone-SE / mobile top-band declutter** ✅ (#413).

## 7. SOTA backing

- **Occlusion-by-composition** (grid of bounded regions, not z-index management): ArcGIS calcite-shell ("map provides content not layout; occlusion prevented through layout composition"), reserved-space CSS variables, extent-indicator convention.
- **Canvas + flanking panels + bottom strip + collapse-chrome**: Figma UI3; object-tree + canvas + composed inspector: NASA Open MCT; avoid free-float re-dock: QGIS #29177.
- **Density ≠ clutter — hierarchy/arrangement, not suppression**: Bloomberg Terminal; Matt Strom "UI Density"; tabbed-on-contention.
- **Never disable / opacity-dim reads as disabled**: NN/g Progressive Disclosure (defer-then-reveal, reachable not hidden); Microsoft Win32 + Adrian Roselli "don't disable" — opacity-dim reproduces every disabled-button failure without the honesty of an error.

## 8. Supersedes

This supersedes the remaining portal cascade. **PR8 (`mask`/hide) and PR9 are
cancelled** — hiding is the same disabled-by-presumed-intent mistake as dimming,
terminal. The portal work's surviving value (instrument content, the
dossier-as-inspector instinct, the framed-map aesthetic, the carry-the-query drill)
is absorbed into the grid regions. The hard-won **infra stays** — the SwiftShader
camera (now multi-breakpoint), the browser-RBE smoke suite (now enforcing the
no-dim + non-overlap invariants), the relevance module, the deep-tool data.

## 9. "Instrument Bay" — the W2–W5 execution plan (research-backed)

A 4-phase, ~11-agent research+design pass (audit → SOTA research → 3 proposals →
synthesis) chose the **Instrument Bay** spine: the map is **one gauge in a balanced
deck**, not the whole point. Grounded in: NN/g Progressive Disclosure (2-level cap;
reachable, never hidden) · Esri Calcite Shell (dock-pushes, overlay-banned; map
padding re-adjusts) · VS Code Activity Bar + Material 3 Nav Rail (always-on,
full-opacity launcher whose click swaps a docked panel) · Roberts CMV
brushing-and-linking (carry-the-query) · NN/g Spatial Memory (shrink by **re-sizing
tracks**, never reflowing) · Palantir Foundry / Figma UI3 (LEFT=inputs / RIGHT=outputs;
map controls on the map's **own** edge) · Flightradar24 + NN/g pogo-sticking
(launcher tiles carry a live headline value so users rarely drill) · Grafana Geomap +
GEE SplitPanel (map = one co-equal, resizable pane).

**Operator decisions (2026-06-02):** (1) **build Cmd-K** — a fuzzy command palette is
the cheapest "real navigation UX" win for a keyboard-first expert audience (additive,
hides nothing); letter-chords T/P/A/V + number-keys 1–4 ship alongside. (2) **shrink
the map** — modest ~36–46% with a hard 380px floor where it fits (≥1366px; the laptop
band 1024–1365px uses a 1fr stage so the floor can't force overflow) + a one-key
"maximize map". (3) **W3 desktop-only, keep the ≤1023px float fallback** — defer the
`--field-panel-*` deletion to W4 so mobile is never orphaned.

The lens still re-weights by **order + grouping + size + accent-label only** (§4) —
every launcher tile and readout section stays `opacity:1` and clickable in every lens.

### Waves
- **W2 — Instrument-bay ratio + carry-the-query + TOOLS cluster + two-group readout** ✅ (#383–385).
  Make the room before the tools move in: re-size the WIDE grid (RAIL 20→22rem,
  INSPECTOR 22→26/30rem, STAGE a fractional remainder); a persistent **TOOLS launcher
  cluster** (4 full-opacity, lens-ordered tiles) at the bottom of the RAIL; the
  PointReadout's lead / support / "More — N ▾" hierarchy; the shared `query`
  `{lat,lon,et,lens,layers,boresight,horizon}` rune so one map-click feeds everything.
  _(Shipping in slices: ratio + cluster first, readout hierarchy + clickable
  instruments next.)_
- **W3 — Deep tools dock IN the INSPECTOR (master-detail)** ✅ (#386). `TransmissionSheet` /
  `PassPlanPanel` / AQ render inside `.deck-inspector` yoked to the pinned point; tools
  become non-mutually-exclusive ordered sections; seeded (ghosted/"sample") empty
  states; finish carry-the-query (Links/Orbit hit ≤2 clicks). **WIDE-only**; the
  ≤1023px float fallback stays until W4.
- **W4 — Re-home the MapToolbar onto the stage's top edge + DOCK peek + responsive
  reflow (MEDIUM/COMPACT)** ✅ (#389–393). The MapToolbar re-home actually landed early
  in #385; the `--field-panel-*` math was **kept** (it is the live short-landscape float
  fallback — W4d/TIN-1867 was cancelled as obsolete, not executed).
- **W5 — Per-lens accents (label-paired) + accelerators (Cmd-K + T/P/A) + click-budget
  enforced in the smoke suite + docs** ✅ (#399–403). _(The V-chord + per-lens splitter
  defaults + maximize-stage were dropped/deferred — no clean target; tracked on TIN-1870.)_

### Click budgets (enforced as a smoke-suite invariant in W5)
Sky hover=0 / ≤1 · Air ≤1 · Links ≤2 · Orbit ≤2 — a tested, non-regressing property.
