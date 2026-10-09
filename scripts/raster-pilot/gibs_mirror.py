"""Mirror a NASA GIBS WMTS raster layer into a static XYZ PNG pyramid (RV12 interim).

Used for the darkmap VIIRS night-lights layer while the VNP46A4 2019 render
(scripts/raster-pilot/pyramid.py) waits on an Earthdata token. GIBS imagery is
public, needs no login and may be redistributed with the acknowledgment
"Imagery courtesy NASA EOSDIS GIBS" (https://nasa-gibs.github.io/gibs-api-docs/).

The output layout matches src/lib/server/raster/SelfHostedTiles.ts:
`<out>/<z>/<x>/<y>.png` (XYZ, EPSG:3857, 256 px). The bytes are GIBS's own
tiles, unmodified. A `manifest.json` records the product, time, tile matrix
set and counts, and `SHA256SUMS` lists every tile.

Usage norms: modest concurrency (default 4), an identifying User-Agent,
retries with backoff on 429/5xx, and resumable runs (existing valid PNGs are
kept, not refetched). Standard library only.
"""

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import urllib.error
import urllib.request

GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
USER_AGENT = "darkmap.phasi.space-tile-mirror/1.0 (+https://darkmap.phasi.space; TIN-1287)"


def log(message):
    print(f"gibs-mirror: {message}", file=sys.stderr, flush=True)


def tile_url(layer, time_value, matrix_set, z, x, y):
    # WMTS order is TileMatrix/TileRow/TileCol, i.e. z/y/x.
    return f"{GIBS}/{layer}/default/{time_value}/{matrix_set}/{z}/{y}/{x}.png"


def valid_png(path):
    try:
        with open(path, "rb") as fh:
            head = fh.read(8)
        return head == PNG_SIGNATURE and path.stat().st_size > 64
    except OSError:
        return False


class Pacer:
    """Caps the global request rate so concurrency never turns into a burst."""

    def __init__(self, per_second):
        self.interval = 1.0 / per_second if per_second > 0 else 0.0
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self):
        if not self.interval:
            return
        with self.lock:
            now = time.monotonic()
            at = max(now, self.next_at)
            self.next_at = at + self.interval
        delay = at - time.monotonic()
        if delay > 0:
            time.sleep(delay)


def fetch_one(args, pacer, z, x, y):
    dest = Path(args.out) / str(z) / str(x) / f"{y}.png"
    if valid_png(dest):
        return "kept"
    url = tile_url(args.layer, args.time, args.matrix_set, z, x, y)
    delay = 2.0
    for attempt in range(1, args.retries + 1):
        pacer.wait()
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                body = res.read()
                ctype = res.headers.get("content-type", "")
            if not body.startswith(PNG_SIGNATURE) or "png" not in ctype:
                raise ValueError(f"not a PNG ({ctype}, {len(body)} bytes)")
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(".png.part")
            tmp.write_bytes(body)
            os.replace(tmp, dest)
            return "fetched"
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return "missing"
            if err.code not in (429, 500, 502, 503, 504) or attempt == args.retries:
                raise RuntimeError(f"{url}: HTTP {err.code}") from err
            retry_after = err.headers.get("retry-after") if err.headers else None
            pause = float(retry_after) if retry_after and retry_after.isdigit() else delay
            log(f"HTTP {err.code} on {z}/{x}/{y}, retry {attempt} in {pause:.0f}s")
            time.sleep(pause)
        except (urllib.error.URLError, TimeoutError, ValueError, ConnectionError) as err:
            if attempt == args.retries:
                raise RuntimeError(f"{url}: {err}") from err
            log(f"{type(err).__name__} on {z}/{x}/{y}: {err}; retry {attempt} in {delay:.0f}s")
            time.sleep(delay)
        delay = min(delay * 2, 120.0)
    raise RuntimeError(f"{url}: retries exhausted")


def tiles(min_zoom, max_zoom):
    for z in range(min_zoom, max_zoom + 1):
        n = 1 << z
        for x in range(n):
            for y in range(n):
                yield z, x, y


def write_manifest(args, counts, started):
    out = Path(args.out)
    sums = []
    for z in range(args.min_zoom, args.max_zoom + 1):
        zdir = out / str(z)
        if not zdir.is_dir():
            continue
        for path in sorted(zdir.rglob("*.png")):
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            sums.append(f"{digest}  {path.relative_to(out).as_posix()}")
    (out / "SHA256SUMS").write_text("\n".join(sums) + "\n")
    manifest = {
        "schema": "darkmap-self-hosted-pyramid/v1",
        "source": "NASA EOSDIS GIBS WMTS (EPSG:3857, best)",
        "gibs_layer": args.layer,
        "gibs_title": args.title,
        "time": args.time,
        "tile_matrix_set": args.matrix_set,
        "url_template": f"{GIBS}/{args.layer}/default/{args.time}/{args.matrix_set}/{{z}}/{{y}}/{{x}}.png",
        "product": args.product,
        "attribution": "Imagery courtesy NASA EOSDIS GIBS; " + args.product,
        "min_zoom": args.min_zoom,
        "max_zoom": args.max_zoom,
        "tile_size": 256,
        "format": "image/png",
        "layout": "{z}/{x}/{y}.png (XYZ)",
        "bytes_modified": False,
        "counts": counts,
        "tiles_total": len(sums),
        "started_at": started,
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "user_agent": USER_AGENT,
        "concurrency": args.concurrency,
        "max_rate_per_second": args.rate,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    log(f"manifest: {len(sums)} tiles, counts {counts}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--layer", default="VIIRS_Black_Marble")
    parser.add_argument("--title", default="Black Marble (VIIRS, Suomi NPP)")
    parser.add_argument("--time", default="2016-01-01")
    parser.add_argument("--matrix-set", default="GoogleMapsCompatible_Level8")
    parser.add_argument("--product", default="NASA Black Marble 2016 annual composite (VIIRS Day/Night Band, Suomi NPP)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--min-zoom", type=int, default=0)
    parser.add_argument("--max-zoom", type=int, default=8)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--rate", type=float, default=12.0, help="global request cap per second")
    parser.add_argument("--retries", type=int, default=6)
    args = parser.parse_args()
    if not 0 <= args.min_zoom <= args.max_zoom <= 8:
        parser.error("zoom range must be within 0..8 (GoogleMapsCompatible_Level8)")
    if args.concurrency < 1 or args.concurrency > 8:
        parser.error("concurrency must be 1..8")

    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    Path(args.out).mkdir(parents=True, exist_ok=True)
    pacer = Pacer(args.rate)
    counts = {"fetched": 0, "kept": 0, "missing": 0}
    total = sum(1 << (2 * z) for z in range(args.min_zoom, args.max_zoom + 1))
    done = 0
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        pending = set()
        source = tiles(args.min_zoom, args.max_zoom)
        exhausted = False
        while pending or not exhausted:
            while not exhausted and len(pending) < args.concurrency * 4:
                try:
                    z, x, y = next(source)
                except StopIteration:
                    exhausted = True
                    break
                fut = pool.submit(fetch_one, args, pacer, z, x, y)
                fut.tile = (z, x, y)
                pending.add(fut)
            if not pending:
                break
            finished, pending = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
            for fut in finished:
                done += 1
                try:
                    counts[fut.result()] += 1
                except Exception as err:  # noqa: BLE001 - recorded and reported
                    failures.append(f"{fut.tile}: {err}")
                if done % 2000 == 0:
                    log(f"{done}/{total} {counts} failures={len(failures)}")
    if failures:
        log(f"{len(failures)} tiles failed; rerun to resume. First: {failures[:5]}")
        return 1
    write_manifest(args, counts, started)
    return 0


if __name__ == "__main__":
    sys.exit(main())
