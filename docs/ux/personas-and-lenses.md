# darkmap — personas & the power-tool lens model

**Status:** Phase 0 (discovery + design). Source of truth for the "power-tool exposure" epic.
This document is design intent + research, not shipped behavior. Implementation is sequenced as
sprints S1–S4 at the end. Companion Figma file linked in §8.

---

## 1. Why this exists (the thesis)

darkmap has grown world-class instrumentation — directable spectral transmission **T(λ)** (live Mie +
HITRAN line-by-line), look-angle/boresight geometry, beam-footprint overlays, slant geometry,
multi-pollutant AQI with source cross-validation, and ephemeris + DEM horizon raycasting. But the
**exposure has not kept pace**: every capability funnels through one map canvas, and the deepest
tools sit **1–3 clicks behind** `map-click → PointReadout CTA → sheet`. The product is framed
astronomy-first; RF/laser has almost no framing, and LEO is named as a use-case with no tooling.

**Thesis:** the engine is built. The work now is making its depth *legible* to four very different
operators — surfacing each audience's power tools to ~1 click on the one shared map, **without
gating** anything. We do this with a **persona "lens"** model (§3), not a fork into separate apps.

### The four personas (and how buried their tools are today)

| Lens | Persona | Power tools (exist today) | Exposure today |
|---|---|---|---|
| **◐ Sky** | Astro instrumentation / astrophotography | VIIRS + Falchi radiance, ephemeris/twilight, SkyCompass, T(λ)@zenith, DEM horizon | Well-served + framed |
| **☁ Air** | Weather / pollen / smog analyst | Atmosphere overlays, PM2.5 field, multi-pollutant AQI, OpenAQ↔CAMS cross-val, history, `/aq` | Moderate; framed second |
| **📡 Links** | Laser / RF instrumentation technician | Directable boresight (az/el), T(λ)+Mie+HITRAN, beam footprint, path-integrated AOD | Buried 2–3 clicks; ~no copy |
| **🛰 Orbit** | LEO instrument setup & Tx (ground-station) | Slant geometry, airmass, DEM horizon occlusion, T(λ) vs elevation | No pass tooling — net-new build |

---

## 2. Design principles (carried from the V6 honesty bar)

1. **Re-weight, never gate.** A lens changes *emphasis* (order, prominence, primary CTA), not
   availability. Every capability stays reachable from every lens. Progressive disclosure, not
   walled gardens.
2. **Honesty first.** Every value is labeled measured / modeled / predicted with coverage. AQI shows
   its averaging basis; Orbit predictions show TLE epoch age; turbulence/scintillation is labeled an
   estimate. Null ≠ 0; gaps stay gaps; sources are compared only where both have data.
3. **One canvas.** The map is shared. Lenses live as a switcher on it; deep links carry the lens.
4. **Speak each operator's language.** Native units and terminology per lens (Bortle/SQM; AQI bands;
   dB/dBm/dBi; AOS/LOS/az-el) — sourced from real practice (§7), not invented.
5. **Borrow proven conventions** (§7 competitive scan); avoid the documented anti-patterns
   (acronym soup, color-only encodings, "sparse = no data", "where is it" split from "is it usable").

---

## 3. The lens model

A persistent **lens switcher** (chips: ◐ Sky · ☁ Air · 📡 Links · 🛰 Orbit) sits on the map. Choosing
a lens re-weights five surfaces:

| Surface | What the lens changes |
|---|---|
| **LayerRail** | which groups are promoted/expanded vs collapsed (not removed) |
| **PointReadout** | which sections lead / are emphasized; section order |
| **Primary CTA** | the one prominent action in the readout |
| **MapToolbar** | which tools surface first |
| **Basemap default** | per-lens default (e.g. Sky → Dark) |

- **Shareable + deep-linkable:** extend `src/lib/url-hash.ts` `HashState` with `lens?: Lens`
  (`&lens=sky|air|links|orbit`). The existing map↔`/aq` deep-links carry it. Default lens when absent:
  Sky (the historical default) — or inferred from active layers (open question, §9).
- **No mode is a dead end:** a Sky user who toggles a smog layer still sees the AQ readout sections;
  the lens just didn't lead with them.

### Capability → lens promotion matrix (where each tool gets promoted to ~1 click)

| Capability | Sky | Air | Links | Orbit |
|---|---|---|---|---|
| VIIRS / Falchi radiance, Bortle/SQM | ★ lead | ◦ | ◦ | ◦ |
| Ephemeris / twilight / SkyCompass | ★ | ◦ | ◦ | ★ (sun/eclipse constraints) |
| Atmosphere overlays (cloud/AOD/PWV) | ○ (transparency) | ★ lead | ○ (path AOD) | ○ |
| OpenAQ smog field / multi-pollutant AQI | ◦ | ★ lead | ◦ | ◦ |
| AQ dashboard `/aq` (history, cross-val) | ◦ | ★ CTA | ◦ | ◦ |
| Spectral transmission T(λ) | ○ (seeing/extinction) | ◦ | ★ lead | ★ (vs elevation) |
| Directable boresight (az/el) + beam footprint | ○ | ◦ | ★ CTA | ○ (reused for az/el track) |
| DEM horizon raycast | ○ | ◦ | ○ | ★ (AOS/LOS gate) |
| Slant geometry / airmass | ○ | ◦ | ★ (slant loss) | ★ (pass feasibility) |
| Pass prediction (TLE/SGP4) — **new** | – | – | ◦ | ★ CTA |

★ = promoted/primary · ○ = present, secondary · ◦ = available, de-emphasized · – = N/A

---

## 4. Personas — JTBD, user stories, re-weighting, storyboard

Each story must trace to a **≤1-click path under its lens**. "Capabilities" names the existing
modules the story rides on.

### 4.1 ◐ Sky — astro instrumentation / astrophotography

**Who:** an observer/astrophotographer planning the night before. **JTBD:** "Tell me *when and where*
tonight is dark, clear, and steady enough for my target — and for my imaging mode."

**User stories**
- *As an astrophotographer, I want the **dark window** (between astro-twilight bounds, minus moon-up
  hours) for tonight at this site* → so I know my usable imaging block. (ephemeris/twilight, moon alt)
- *I want **sky darkness** here as measured (VIIRS/Falchi → Bortle/SQM) and directional* → site quality.
- *I want **seeing vs transparency** separated* — turbulence (resolution) vs haze/AOD extinction
  (depth) — because I act on them differently. (T(λ)/AOD, cloud overlays)
- *I want a **target altitude/airmass curve** over the night with a min-altitude threshold.* (slant geom)
- *I want to declare **narrowband vs broadband** so moon/light-pollution penalties re-weight* (NB rejects
  LP/moon ~2–3 Bortle classes for emission targets).

**Lens re-weighting:** rail promotes VIIRS/Falchi + atmosphere-transparency; readout leads
Bortle/radiance → dark-window timeline → seeing/transparency; CTA "Plan observation" (T(λ) extinction +
airmass at the target look-angle); toolbar leads ephemeris; basemap Dark.

**Storyboard (frames → Figma):** 1) land in Sky, search site · 2) dark-window timeline (twilight +
moon + clear hours) · 3) click point → Bortle/SQM + transparency readout · 4) set imaging mode
(NB/BB) → penalties re-weight · 5) target altitude curve + min-alt line · 6) "Plan observation" →
T(λ)/airmass at look-angle · 7) copy shareable deep-link (carries lens+point+time).

**Design implications (sourced §7B):** lead with the dark window; SQM/Bortle as a *directional
measured* field paired with modeled brightness; separate seeing from transparency; per-target
altitude/airmass curve; imaging-mode toggle as first-class.

### 4.2 ☁ Air — weather / pollen / smog analyst

**Who:** an environmental/AQ analyst (or allergy-sensitive planner). **JTBD:** "Is the air getting
better or worse here, do the sources agree, and when is the exposure window?"

**User stories**
- *I want the **driving pollutant** alongside the composite AQI*, with PM2.5/PM10/O3/NO2 toggleable.
- *I want every AQI value to **disclose its averaging basis*** — NowCast (real-time, ~12-h weighted)
  vs the official 24-h daily — never an instantaneous concentration styled as official AQI.
- *I want **source provenance + an agreement signal*** across ground stations (OpenAQ), model (CAMS),
  and satellite AOD — trust comes from agreement. (the V6-3 cross-val)
- *I want the **exposure window**: a trend arrow + time-series with data-age/uncertainty.* (V6-2 history)
- *I want **pollen by season + taxon*** (tree/grass/weed), not a single index. (CAMS pollen)

**Lens re-weighting:** rail promotes the atmosphere group (cloud/AOD/PWV/smog); readout leads
PM2.5/AQI + driving pollutant → pollen → history sparkline; CTA "Air-quality dashboard" (`/aq`);
toolbar leads time scrubber.

**Storyboard:** 1) land in Air, search · 2) smog field + atmosphere overlays · 3) click → AQI
(NowCast-labeled) + driving pollutant + provenance/agreement chips · 4) pollen by taxon/season ·
5) history sparkline + trend · 6) "Air-quality dashboard" → `/aq` (cross-val + area overview) ·
7) share deep-link.

**Design implications (sourced §7A):** always disclose averaging basis; surface the driving
pollutant; explicit provenance + visible agreement/disagreement; canonical 6-band AQI palette (offer
the EPA ColorVision-Assist variant), never invented colors; exposure window first-class with
data-age annotation.

### 4.3 📡 Links — laser / RF instrumentation technician

**Who:** a technician designing a directional atmospheric link (terrestrial P2P or ground↔air/space).
**JTBD:** "Given my hardware and this geometry, does the link *close* tonight — with margin?"

**User stories**
- *I want to set a **boresight** (az/el) between/along endpoints and see the geometry + slant range.*
  (directable look-angle — exists)
- *I want **T(λ) and path-integrated AOD along the actual beam** converted to **atmospheric loss in
  dB***, folded into a link budget. (T(λ)+Mie+HITRAN, beam path AOD — exists; dB conversion is new framing)
- *I want to enter the few numbers I always bring — **Tx power (dBm), aperture/gain (dBi), beam
  divergence (mrad), Rx sensitivity (dBm)*** — and get **received power + link margin (dB)** with a
  clear **go/no-go**. (new readout over existing physics)
- *I want the **elevation/airmass penalty** surfaced for slant links* + an optional minimum-elevation
  no-go. (slant geometry/airmass — exists)
- *I want an **honest turbulence allowance** (Cn²/r₀ → scintillation fade), labeled an estimate.* (new)

**Lens re-weighting:** transmission/boresight/beam **promoted out of the buried sheet** to a
first-class Links surface; readout leads T(λ) → path-AOD → loss breakdown; CTA "Design a link" (opens
boresight + beam + the link-budget panel directly); toolbar surfaces the beam-footprint toggle.

**Storyboard:** 1) land in Links, set endpoint(s) · 2) boresight az/el + beam footprint on map ·
3) T(λ) window check at real conditions · 4) link-budget panel: Tx/Rx inputs → loss breakdown
(FSPL/geometric + atmospheric-from-AOD + pointing + scintillation) → **margin dB + go/no-go badge** ·
5) elevation/airmass penalty + min-el line · 6) share the link scenario deep-link.

**Design implications (sourced §7, RF/FSO):** the killer feature is **measured atmospheric state
along the real beam → margin** (generic calculators only approximate from visibility). Add a
link-margin panel + minimal Tx/Rx inputs; show the **loss breakdown term-by-term** (techs debug that
way), not one number; native units (dB/dBm/dBi, nm/µm/GHz, elevation, slant range); turbulence as a
clearly-labeled Hufnagel-Valley-class estimate, not measured.

### 4.4 🛰 Orbit — LEO instrument setup & Tx (ground-station)

**Who:** a ground-station operator planning a satellite pass / instrument up-downlink. **JTBD:**
"When can I see this satellite from my site, is the link feasible over my real horizon, and what's the
az/el track + Doppler?"

**User stories**
- *I want to pick a satellite (NORAD ID/name) and get its **passes over my site** for the next
  window* (AOS / max-el / LOS times + azimuths + duration). (new: TLE+SGP4)
- *I want passes gated by my **real terrain horizon**, not a flat 0°* + a settable min-elevation.
  (DEM raycast — exists; **the signature differentiator**)
- *I want the **az/el sky-track** (polar plot) for a pass, colored by **link quality vs elevation**
  (airmass/transmission gradient), not a binary cutoff.* (SkyCompass dome + T(λ) — exists)
- *I want **honest TLE epoch age**: show source + fetch time, degrade confidence as epoch ages, never
  present times as exact.* (new)
- *I want **Doppler + keyhole flags** per pass* (shift magnitude + sign-flip at culmination; "may
  exceed rotator slew rate" near zenith). (new, coarse)

**Lens re-weighting:** new "Plan a pass" surface; rail promotes the satellite/site context; readout
leads the pass list; CTA "Plan a pass"; toolbar leads ephemeris (sun/eclipse) + the time scrubber.

**Storyboard:** 1) land in Orbit, set ground site · 2) add satellite(s) by NORAD ID → TLE fetched
(epoch-age badge) · 3) pass list (AOS/max-el/LOS + duration), gated by terrain mask + min-el ·
4) select a pass → polar az/el track over the masked-horizon profile, colored by link quality ·
5) per-pass T(λ)/occlusion + Doppler + keyhole flags · 6) share the pass-plan deep-link.

**Design implications (sourced §7, LEO):** polar az/el plot + pass table are the expected conventions
(gpredict/heavens-above) — adopt, don't reinvent; **make the DEM mask the AOS/LOS gate** (our edge);
epoch-age honesty; treat low-elevation as a *gradient* (reuse transmission/airmass); flag keyhole +
Doppler; respect Celestrak fetch cadence (≤ once / 2 h, cache). v1 leads with **terrain-true AOS/LOS +
honest uncertainty**; defer rotator/radio control + footprint maps to v2.

---

## 5. LEO Orbit lens — net-new build scope (specced; built in S3)

Confirmed: no orbit/TLE/SGP4 code or deps exist. The geometry leans on strong reuse.

- **New:** `/api/orbit/tle` proxy → **Celestrak** GP data (no auth; respect the ~2-h update cadence,
  cache, record epoch + fetch time). Space-Track later (auth + rate limits: <30/min, <300/hr).
  In-browser SGP4 via **`satellite.js`** (satrec → ECI → ECF → look angles `{azimuth, elevation,
  rangeSat}` + `dopplerFactor`). Pass-event detection = root-find AOS/LOS at the **terrain-masked**
  horizon, find culmination, integrate duration above min-el.
- **Reuse (do not reinvent):** `src/lib/transmission/{slant-geometry,look-angle}.ts`;
  `src/lib/ephemeris/{airmass,horizonAtAzimuth,EphemerisClient,twilight-phases,pinEphemeris,HorizonProvider}.ts`
  + `TerrariumElevationLookup` (DEM occlusion); the transmission estimator (attenuation vs elevation);
  the time scrubber; `src/lib/components/SkyCompass.svelte` (polar dome → az/el track); adapt
  `src/lib/map/beam-footprint.ts` → sub-satellite coverage circle (v2).
- **Honesty:** SGP4 ~km-scale near epoch, degrading on the order of ~100 m/day (object-dependent — show
  as uncertainty, not a fixed number); km position error → seconds-scale AOS/LOS uncertainty; refraction
  limits near the horizon; "predicted, not observed."
- **v1 vs v2:** v1 = TLE by NORAD ID (cached, epoch-badged) → SGP4 over site/window → DEM-gated pass
  list + polar az/el track annotated by transmission. v2 = sub-satellite footprint, precise Doppler
  tuning UI, rotator/rig hooks, Space-Track.

---

## 6. Honesty + accessibility guardrails (per lens)

- **Air:** NowCast vs 24-h label on every AQI; EPA 6-band palette + ColorVision-Assist option;
  provenance + agreement chips; sparse stations read as sparse (never "clean"); pollen labeled
  experimental where the model is.
- **Sky:** measured (VIIRS/SQM) vs modeled (Falchi) distinguished; moon penalty explicit; seeing and
  transparency never merged.
- **Links:** loss terms itemized; turbulence labeled estimate (HV-class) unless a real Cn² source is
  wired; "engineering estimate, ~5–10% clean-sky error" disclaimer carried.
- **Orbit:** TLE epoch + age + source + fetch time always visible; confidence degrades with age;
  predicted-not-observed; refraction caveat at low elevation.

---

## 7. Research findings (cited)

### 7A. AQ analyst
- US-EPA AQI = 6 color bands (Good→Hazardous); AQI 100 = each pollutant's short-term standard; 2024
  "ColorVision Assist" accessible palette. [airnow.gov/aqi/aqi-basics](https://www.airnow.gov/aqi/aqi-basics/),
  [EPA PM AQI fact sheet 2024](https://www.epa.gov/system/files/documents/2024-02/pm-naaqs-air-quality-index-fact-sheet.pdf)
- Averaging windows are the crux: official daily PM2.5 AQI = 24-h average; O3 = 8-h/1-h; real-time =
  **NowCast** (PM2.5 ≈ trailing 12-h weighted toward recent hours), explicitly an approximation, voluntary.
  [AQI Technical Assistance Doc](https://www.airnow.gov/sites/default/files/2020-05/aqi-technical-assistance-document-sept2018.pdf),
  [eCFR 40 CFR 58 App G](https://www.ecfr.gov/current/title-40/chapter-I/subchapter-C/part-58/appendix-Appendix%20G%20to%20Part%2058)
- Composite AQI = max across pollutants → analysts want the *driving* pollutant.
- 3 sources cross-validated: OpenAQ (accurate, sparse) · CAMS (full coverage, assimilates MODIS AOD550)
  · satellite AOD (global, cloud gaps + conversion error); trust = agreement.
  [CAMS/MERRA-2 vs OpenAQ validation](https://www.sciencedirect.com/science/article/abs/pii/S1352231022000371),
  [OpenAQ satellite validation](https://openaq.org/about/use-cases/validating-satellite-data/)
- Pollen by season + taxon (tree spring / grass late-spring–summer / weed Aug–Sept); NOAA forecasts
  experimental; seasons lengthening. [Climate Central 2026](https://www.climatecentral.org/climate-matters/2026-allergy-season)

### 7B. Astro planner
- Night-before checklist: darkness (Bortle 1–9 + SQM mag/arcsec², directional), moon (full moon
  degrades Bortle-1 → ~Bortle-4; plan ±new moon), astronomical twilight (Sun −18°), cloud, **seeing**
  (turbulence, arcsec/Fried), **transparency** (AOD/extinction), airmass.
  [Sky&Tel planning an imaging night](https://skyandtelescope.org/astronomy-blogs/planning-astro-imaging-night/)
- Narrowband (Hα/OIII/SII) rejects LP/moonlight ~2–3 Bortle classes for emission targets → imaging
  mode changes the calculus. [TEN SIX](https://www.tensixphotography.com/eclipse-blog/astrophotography-planning-shot-worth-taking/)
- Good surfaces: per-target altitude-vs-time curve, the dark window, hourly cloud/transparency/seeing
  grid (Clear Sky Chart model).

### 7C. RF / laser link technician
- Link budget = dB/dBm ledger; decision var = **link margin** = Prx − Rx sensitivity; sized to a target
  availability (ITU-R P.530 fade-margin tiers — verify exact figures against the standard).
  [rftools link budget](https://rftools.io/calculators/rf/rf-link-budget/), [MATLAB link budget](https://www.mathworks.com/discovery/link-budget.html)
- FSO/laser loss terms: beam-divergence/geometric, atmospheric (fog/haze dominant — 850 vs 1550 nm
  ~equal in dense fog), pointing/beam-wander, scintillation. Turbulence via **Cn²** + **Fried r₀**
  (wavelength- and zenith-dependent; Hufnagel-Valley profile).
  [IntechOpen FSO](https://www.intechopen.com/chapters/47585), [OSTI Cn²→r0](https://www.osti.gov/servlets/purl/897959),
  [ITU-R P.1817 terrestrial FSO](https://www.itu.int/rec/R-REC-P.1817/en)
- Airmass ~ 1/sin(elevation): ~1 zenith, ~2 at 60° zenith, ~38 at horizon → operational min-elevation.
  [airmass](https://en.wikipedia.org/wiki/Air_mass_(astronomy))
- Tooling gap: rigorous calculators have no map/geometry; map tools have no link budget. **Nobody
  couples measured atmospheric state along the real beam to a margin readout** — our opening.

### 7D. LEO ground-station ops
- Pass descriptors AOS / max-el(culmination) / LOS + az/el track + duration above min-el; low elevation
  penalized (slant range, atmosphere, terrain mask, multipath). [pass geometry](https://satellitegroundstation.com/resources/pass-geometry-basics-elevation-azimuth-duration-slant-range/)
- **Keyhole problem**: az rate → ∞ near zenith; high-max-el passes can be untrackable by az/el mounts.
  [keyhole problem](https://en.wikipedia.org/wiki/Keyhole_problem)
- Doppler: large continuously-changing offset; uplink pre-comp + downlink correction; sign flips at
  culmination. [Doppler](https://satellitegroundstation.com/resources/doppler-shift-explained-and-how-stations-compensate/)
- TLE/SGP4: Celestrak (no auth, ~2-h cadence) / Space-Track (auth, rate-limited); epoch age degrades
  accuracy (~km near epoch, growing); **`satellite.js`** is the browser SGP4.
  [Celestrak GP](https://celestrak.org/NORAD/documentation/gp-data-formats.php), [satellite.js](https://github.com/shashwatak/satellite-js)
- Conventions: polar az/el plot + pass table (gpredict, heavens-above, n2yo); incumbents assume a flat
  horizon and split "where is it" from "is the link feasible" — our **DEM-true AOS/LOS** is the edge.
  [gpredict](https://github.com/csete/gpredict)

### 7E. Competitive scan (borrow / avoid)

| Tool | Borrow | Avoid |
|---|---|---|
| lightpollutionmap.info | toggleable overlays + clear provenance | acronym-heavy menu, no inline explanation |
| Clear Sky Chart | compact hourly cloud/transparency/seeing grid | color-only encoding, no in-context legend |
| Astrospheric / Telescopius | astronomer-only variables; per-target altitude curves + framing | feature density; gear-setup cold start |
| heavens-above / n2yo | live sky chart + ground track; client-side pass prediction | dated, dense, design-last IA |
| AirNow / OpenAQ Explorer | click-monitor → NowCast + raw + history; diurnal "Patterns" | tab/dropdown clunk; sparse reads as "no data" |
| IQAir | clean global live map, approachable framing | blended sensor classes w/o provenance; upsell |

*Uncertainty flags:* exact ITU-R P.530 margin-vs-availability numbers and the "~100 m/day" SGP4 / "15–20°/s
keyhole" figures are illustrative (verify per standard/object before publishing). NOAA pollen is
experimental. No formal published UX critique of lightpollutionmap.info was found — "avoid" notes are
inferred from its documented interface.

---

## 8. Figma

Companion file (lens switcher component, the 4 lens map states, the Links "Design a link" surface,
the Orbit "Plan a pass" surface, and the per-persona storyboard frames). **Link:**
https://www.figma.com/design/DYMVqVYzHl8uehosEmWXdt (darkmap — persona lenses, Phase 0). Mockups
inherit the omux theme (amber `#ffd166` + cyan accents, dark surfaces) and the EPA 6-band AQI
palette. Built via the `figma-console` / `use_figma` MCP path. The refined **Sky** exemplar (Bortle
headline + on-demand provenance + right tool-rail) is the template; remaining frames follow the §11
build-ready specs.

---

## 9. Implementation roadmap (later sprints — specced, not built in Phase 0)

- **S1 — Lens nav engine.** `url-hash` `lens`; the switcher UI; the re-weighting wiring across
  `LayerRail` / `PointReadout` / `MapToolbar` (lens-aware ordering + primary CTA). No new data.
- **S2 — Links promotion.** Un-bury transmission/boresight/beam to 1-click in Links; add the
  link-budget panel (Tx/Rx inputs → loss breakdown → margin dB + go/no-go) + path-AOD→dB; airmass
  penalty; labeled turbulence estimate.
- **S3 — Orbit build.** `/api/orbit/tle` (Celestrak) + `satellite.js` SGP4 + DEM-gated pass detection +
  polar az/el track + per-pass transmission/occlusion + epoch-age honesty + Doppler/keyhole flags.
- **S4 — Polish.** Per-lens onboarding/tour, copy/voice per persona, docs-page refresh, live `/browse` QA.

Each sprint carries the standard gate (lint + svelte-check + vitest + e2e + bazel green) and its own
honesty/coverage review.

## 10. Open questions (for design review)

1. **Default lens** when the hash has none: Sky (historical) vs infer-from-active-layers vs a one-time
   chooser. (Leaning: Sky default + remember last.)
2. **Switcher placement** on mobile (the top is crowded with the geocoder) — chips vs a segmented
   control in the toolbar.
3. **Links Tx/Rx inputs**: how much hardware config before value appears (cold-start risk per
   Telescopius) — propose sensible defaults + an "advanced" disclosure.
4. **Orbit satellite picker**: curated list (ISS, common cubesats, weather sats) vs free NORAD-ID entry
   vs both.
5. Is a **task-launcher home** still wanted later as a complement to lenses (deferred from the nav
   decision), or do lens chips fully cover first-touch?

---

## 11. Deep UX research synthesis (SOTA pass)

Synthesized from a multi-agent UX study (5 cited domains — drill-down efficiency, lens/mode
switching, kiosk/attract-loop data-storytelling, header/sidebar/tool-rail patterns, and a
finite-state model of the future cycling mode — each adversarially checked for darkmap fit + the
honesty bar). This refines §3–§5 with build-ready detail; nothing here gates a capability.

### 11.1 Thesis + the lens engine

The redesign's only job is to make existing depth **legible**. One MapLibre canvas; the lens is a
single reactive rune store (mirror `src/lib/theme.svelte.ts`: `lens = $state<'sky'|'air'|'links'|'orbit'>('sky')`).
The five surfaces (LayerRail order, PointReadout section order, primary CTA, MapToolbar order,
basemap default) are **`$derived`** from it — the §3 promotion matrix *is* the derivation map.
**Canvas state (center/zoom/marker/time) is orthogonal** — the lens never writes it, so a flip
re-derives only framing and the map stays put by construction. Add `lens?: Lens` to `HashState`
(`&lens=`), default Sky, remember-last via localStorage.

### 11.2 The 3-tier drill rhythm (one grammar, all lenses)

- **Tier 1 — canvas:** lens re-weights rails + basemap, never gates.
- **Tier 2 — one map-click → PointReadout** whose TOP slot is exactly *[one decision value +
  measured/modeled/predicted + coverage label + one primary CTA]*: Sky = Bortle + dark-window +
  "Plan observation"; Air = driving pollutant + NowCast-labeled AQI + "Air-quality dashboard";
  Links = T(λ) window + path-AOD + "Design a link"; Orbit = next DEM-gated pass + epoch-age +
  "Plan a pass". Everything else collapses below the lead behind **value-bearing honesty chips**
  (e.g. `Transmission · T(550nm)=0.78 · modeled · cov 92%`, `Next pass 21:14 · predicted · TLE epoch 3d`).
- **Tier 3 — deep tool**, opened by the CTA/chip, **inherits the full query with zero re-entry**:
  `{lat,lon}` + `et=` instant + lens + basemap + on-layers + (Links) boresight az/el + path-AOD;
  (Orbit) the DEM-masked horizon already applied. **The click *is* the query.** Net: map→point→tool
  in two clicks, no re-specification.
- **Acceptance gate:** switching lens *reorders* the same readout sections + swaps the CTA — it never
  adds/removes a capability. No per-lens forked components.

### 11.3 Re-weight rules (dim + reorder, never hide/disable)

3-tier opacity: **Tier-1** (active headline value + single CTA) full amber/cyan; **Tier-2**
(active-lens layers/tools) full opacity, no accent; **Tier-3** (off-lens rows/chips/toolbar items)
~0.55 opacity + lighter weight, **still keyboard-focusable + clickable**. Forbidden: `aria-disabled`,
`display:none`, removal. The MapLibre canvas always outranks chrome in contrast. Animate **only the
diff** (~150–250ms rail reorder + CTA label cross-fade), behind the shipped `prefers-reduced-motion`
guard; **never animate the map viewport**. Per-lens basemap change is a **subtle default-only nudge**
— never overrides an explicit user choice, never alters an active overlay's apparent meaning.

### 11.4 The rails

- **Header (top-left):** the persistent lens switcher as icon+label **chips** (◐ Sky · ☁ Air ·
  📡 Links · 🛰 Orbit), active state **not color-alone** (filled pill + bold label, per the
  ColorVision-Assist commitment). 4 chips fit the 3–5 segmented ceiling; chips (not a flush segmented
  control, not tabs). One-action switch + number keys 1–4. Geocoder pill persists to the right. ≤820px:
  collapse to a compact segmented control / fold into the toolbar — never a keyboard-only palette.
- **Left LayerRail:** caret accordions by data family — Night-lights (VIIRS measured / Falchi modeled),
  Atmosphere (cloud/AOD/PWV/smog), Terrain (DEM horizon), Ephemeris (sun/moon/twilight). **Multi-expand**
  (never auto-collapse a user-opened section); a lens **auto-expands its primary group + scrolls it to
  top** without collapsing others. **Each accordion header carries the measured/modeled/predicted +
  coverage chip** (provenance visible even when collapsed). Per-row visibility toggle + opacity slider.
- **Right tool surfaces (two stacked, not a new column):** (A) the **bottom-right MapToolbar re-fixed
  as a LABELED tool strip** — icon+label rows (fix the current tooltip-only a11y gap *before* adding
  ambiguous tool glyphs), the active lens's signature tool promoted to first at Tier-1. (B) the
  **bottom-right PointReadout** = details-on-demand; the deep tool opens as a **non-occluding docked
  panel / map-shrinking sheet** (fixing `TransmissionSheet`'s current hide-the-readout) so boresight/
  DEM-horizon/beam/ground-track stay legible against terrain. Readout capped ~22rem; on mobile the map
  shrinks rather than being covered.
- **Time dock (bottom edge):** ONE shared control (NASA Worldview grammar — range + play/pause + step +
  pace + loop) bound to `et=`, used for both manual scrub and the future cycling engine. **Encodes data
  availability**: steps real frames only, **holds/skips gaps, never interpolates** (null≠0); each frame
  renders inline provenance + freshness + basis. Insets off `--toolbar-w-rem`. Promoted to first toolbar
  slot in Air + Orbit.

### 11.5 Key IA refinements (deltas to act on)

- **Bortle-prominent / provenance on-demand** (operator direction): the Sky lead is a single Bortle
  headline (large class + SQM beneath), **no inline "modeled" tag by default**; a small `(i)`
  (existing HelpTooltip) discloses "Falchi 2016 modeled, cross-checked vs VIIRS measured, coverage N%".
  Measured-vs-modeled is one tap away, never deleted.
- **Fix the occluding deep tool** (S2): `TransmissionSheet` must stop hiding the readout — dock
  non-occluding / shrink the map. Overview+detail, never zoom-to-feature, never fisheye.
- **Label the MapToolbar** (S1, before promoting tool glyphs): transmission/boresight/beam/passes have
  no universal glyph; add visible labels or default-expanded.
- **Defer past S4:** Cmd-K command palette + pin/compare (multi-point) — net-new subsystems for an
  audience of four; the chips + labeled toolbar + carry-the-query drill already deliver ~1 click.
  Keep only number-keys 1–4.

### 11.6 Cycling mode — finite-state narration engine (IA-readiness contract, NOT a Phase-0 build)

A future hands-off auto-tour is a thin **driver** over the same lens store + shared time dock + the
shipped `Tour.svelte` plumbing (auto-start/replay/localStorage-suppress/reduced-motion) — **not a
forked kiosk app**. A Martini-Glass realized as a **stepper** (not scrolljack, not silent autoplay):
an ordered story walks states on rails; any touch on map/rail/toolbar/geocoder **pauses and stays
paused** (drops into free exploration). Each state fires the same five-surface re-weight, loads its
layer, starts one staged animation, and is **gated by a data-readiness guard** (refuses to narrate an
empty/half-loaded frame or a null-provenance frame). Transport: play/pause + skip + scrub + "step N
of M" dot-rail + "Skip / Explore freely"; `prefers-reduced-motion` → stepped cross-fades + longer
dwell (data-state change always preserved, positional motion suppressed); advance never bound to map
scroll/zoom.

| # | State | Lens | Data (provenance) | Animation | Dwell |
|---|---|---|---|---|---|
| S1 | Weather & cloud advection | Air | GIBS MODIS cloud (measured/sat) | day-step loaded GIBS tiles, raster crossfade, gaps held | 12s |
| S2 | Smog & AQI (driving pollutant) | Air | OpenAQ PM2.5 field + AQI (modeled, NowCast) + cross-val | hourly snapshot cross-fade; sparse = sparse | 10s |
| S3 | Moon, twilight & DEM datum | Sky | ephemeris moon/twilight (computed) + DEM horizon | dark-window sweep; horizon vs dome | 8s |
| S4 | Atmospheric link & Tx indices | Links | T(λ) (modeled Mie+HITRAN) + path-AOD→dB + Ångström + beam | beam sweep az/el; loss bars build; fly along beam | 16s |
| S5 | Animated AQ history | Air | hourly OpenAQ history (measured; gaps stay gaps) + trend | sparkline + field morph via time dock | 10s |
| S6 | darkmap radiance (Bortle) | Sky | VIIRS measured + Falchi modeled → Bortle/SQM | radiance opacity ramp; Bortle updates | 8s |
| S7 | DEM-gated pass track (conditional) | Orbit | SGP4 az/el (predicted) gated by DEM horizon; TLE epoch | AOS→LOS marker on polar dome, uncertainty widens; **skipped if no satellite pinned** | 15s |

Honesty rides every frame (the engine refuses a null-provenance frame; gaps never tweened; AQI stays
NowCast-labeled; Orbit stays "predicted (SGP4) · TLE epoch +Nd" with widening uncertainty; a tour can
never make a modeled/predicted value sound measured). Then loop → S1.

### 11.7 Build-ready Figma frame specs

The companion Figma file (§8) renders, per `figma_frame_specs`: **Sky (refined — done)**, **Air map
state**, **Links map state**, **Orbit map state**, **Links — Design a link** (Tx/Rx → loss breakdown
→ margin dB + go/no-go, non-occluding dock), **Orbit — Plan a pass** (master pass-list ↔ detail polar
az/el track over the DEM-masked horizon), and **Cycling mode — auto-tour** (transport overlay +
per-frame provenance). Each carries its lens-led readout section order, the promoted toolbar tool, the
auto-expanded rail group, the primary CTA, and honest map treatment (no occlusion, subtle basemap).
