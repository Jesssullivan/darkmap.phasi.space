# Ephemeris Tile-Cache Contract

Darkmap uses two ephemeris paths with different cache boundaries.

## Tile-Cacheable

The mobile dusk rail's viewport spread is a geometric summary: for a UTC day,
sample sun/moon event times across a coarse Web-Mercator tile cover and show the
min/max range. This is safe to cache by:

```text
ephem-range:v1:{mode}:{YYYY-MM-DD}:z{summaryZoom}:x{x-ranges}:y{y-range}:s{samples}
```

Current mode is `geometric`. The summary zoom is deliberately coarser than the
map zoom:

| Map zoom | Summary tile zoom |
| --- | --- |
| `< 5` | `5` |
| `5..7.999` | `6` |
| `8..10.999` | `7` |
| `>= 11` | `8` |

This keeps small phone pans inside the same cache entry while still changing
the key when the user crosses a meaningful tile boundary. Samples are taken
from the canonical tile-cover bounds, not from the first raw viewport that
happened to produce the key, so a cache hit is deterministic.

## Observer-Specific

Terrain-horizon-aware ephemeris is not tile-cacheable as a final result. A
single map tile can contain materially different eastern or western horizons,
so selected pins, GPS fixes, and future route/KML/GPX points must stay
observer-specific.

Reusable primitives remain cacheable:

- decoded Terrarium elevation tiles
- rounded-location horizon polygons
- dense horizon fans near the sun azimuth for a selected point

## UI Contract

The bottom rail may show a stable tile-cover summary for the visible area.
Point readouts, GPS follow mode, and route waypoints must use precise
point-level ephemeris and may display deltas against the rail summary.

The rail must make cache state visible:

- `live` means the current tile-cover summary was freshly computed.
- `cache` means the current summary came from an in-flight or completed local
  cache hit.
- `offline cache` means the browser reports offline while showing the latest
  local summary for the current key.
- `stale` / `offline stale` means a new viewport key is pending or failed and
  the rail is temporarily keeping the previous summary visible.
