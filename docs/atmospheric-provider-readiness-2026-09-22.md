# Atmospheric provider readiness — 2026-09-22

Lane: production reliability / public content. Existing scope: TIN-1757
(OpenAQ normalization), TIN-1889 (station parity), AQ-4 (wind-driven diffusion).

## Fresh public evidence

Read-only probes at approximately **2026-09-22 19:54 UTC**, against
`https://darkmap.phasi.space`:

- `/api/atmospheric/openaq?bbox=-77,42,-76,43&markers=1`: HTTP 200,
  `degraded:false`. Connecticut Hill (location 474) was present but stale,
  with `lastSeen:2026-09-21T17:00:00Z`, beyond the 24-hour freshness cutoff.
- `/api/atmospheric/airquality?lat=42.443&lon=-76.501&time=2026-09-22T20:00:00Z`:
  HTTP 200, CAMS PM2.5 7.7 µg/m³; all pollen fields null. These are a model
  output and unavailable pollen, respectively, not measured ground-station
  PM2.5 or zero pollen.
- Equivalent `/api/atmospheric/point`: HTTP 200 with weather model output.
- Sensor.Community's credential-free bbox endpoint
  `https://data.sensor.community/airrohr/v1/filter/box=42,-77,43,-76`
  returned `[]` with an identifying Darkmap User-Agent. It therefore did not
  supply additional observations for this sampled Ithaca-area viewport.

These probes do **not** establish global uptime. They do rule out treating this
sample's stale/empty station field as proof of invalid credentials. No secrets
were inspected, changed or rotated.

**AirNow versus ColorVision Assist is a palette choice**, not provider selection.
Both repaint the same AQI calculation and input data. Darkmap's AirNow-named
palette does not imply an AirNow API integration.

## Scoped corrections

- OpenAQ metadata and raw readings share a bounded five-minute per-process
  cache and duplicate in-flight requests. An eight-second request timeout and
  shared 429 cooldown avoid hanging calls and repeated requests during a
  provider outage. Healthy cached observations still go through the existing
  freshness filter; failed requests are not cached as successful empty data.
- Partial upstream failures are explicitly degraded, while history searches
  with no station/pollutant coverage are healthy-empty. Reasons distinguish
  missing configuration, unauthorized, rate limiting, unavailable transport,
  malformed response and absent coverage. Provider values are not fabricated.
- Weather explicitly requests `wind_speed_unit=ms`; upstream defaults to km/h,
  while Darkmap's diffusion model expects m/s. Missing cloud fields no longer
  become invented zero cloud cover.
- Weather and CAMS reject requested times more than half an hour from any
  returned hourly forecast. Moving the astronomy timeline to a different month
  must not silently display today's closest atmospheric model hour.

## Public/FOSS source tradeoffs

| Source | Access and coverage | Integration boundary |
| --- | --- | --- |
| OpenAQ v3 | Key required; general limits 60/minute and 2,000/hour. Global aggregation with uneven station coverage and provider terms. | Keep measured observations, original provider attribution and fresh/stale distinction. Do not rotate keys for stale stations. |
| Open-Meteo + CAMS | Keyless hosted access is for noncommercial use (up to 10,000 calls/day); code is AGPLv3 and data CC BY 4.0. CAMS global grid is about 45 km; European grid about 11 km. Pollen is Europe-only. | Keep separately labeled modeled guidance, not synthetic sensor markers. Commercial hosted usage or self-hosting is an operator choice; open data does not make hosted commercial service unlimited/free. |
| Sensor.Community | Credential-free observations and open firmware/API; identifying User-Agent required. Homepage links DbCL v1.0 for database contents, with ODbL obligations (not the separate photo license). Local coverage must be measured. | Promising optional low-cost-sensor layer with distinct provenance, sensor quality, units and timestamps. Do not merge into OpenAQ IDs, assume regulatory equivalence, or claim it fixes the sampled empty viewport. |
| AirNow | Actual web services require registration/API key. | A palette label is not a data integration; adding it would add another credentialed dependency. |

Primary sources checked on 2026-09-22:

- [OpenAQ authentication](https://docs.openaq.org/using-the-api/api-key),
  [rate limits](https://docs.openaq.org/using-the-api/rate-limits),
  [coverage and third-party terms](https://docs.openaq.org/about/about).
- [Open-Meteo service/code/data distinction](https://open-meteo.com/),
  [weather units](https://open-meteo.com/en/docs),
  [CAMS coverage, pollen and attribution](https://open-meteo.com/en/docs/air-quality-api).
- [Sensor.Community official API wiki](https://github.com/opendata-stuttgart/meta/wiki/EN-APIs),
  [homepage license links](https://sensor.community/en/),
  [DbCL v1.0](https://opendatacommons.org/licenses/dbcl/1-0/).
- [AirNow API fact sheet](https://docs.airnowapi.org/docs/AirNowAPIFactSheet.pdf).

No new provider, background ingestion, database, credentials, deployment or
infrastructure is introduced by this correction. A future fused display should
retain observed/model/community lanes and attribution, not blend values into an
unqualified authoritative AQI.

## Validation and remaining proof

`just test-atmospheric-providers-local`: **21 tests passed in 3 files** on
2026-09-22, using the existing installed dependency tree as a local diagnostic.
The isolated test configuration avoids requiring generated SvelteKit types for
these node-only adapter tests. `git diff --check` passes.

`just bazel-test-cached //src/lib/atmospheric:atmospheric_test` refused to run
because `BAZEL_REMOTE_CACHE` is unset. Remote proof remains required for both
`//src/lib/atmospheric:atmospheric_test` and
`//:atmospheric_provider_routes_test`; no local result is claimed as RBE,
deployment or browser proof. The Nix shell initialization did not complete and
was stopped. Full application typecheck/build and browser validation were not
run in this isolated provider worktree.
