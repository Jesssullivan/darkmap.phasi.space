# Runtime-cache qualification queue — 2026-10-05

Authority: root's original-owner reattachment and explicit queue behind Mship's
first writer; R-HOOK-CONVERGENCE-20261004, R-N12/R-N13. This delivery helper does
not modify served ec16 or candidate application dd28.

Independent source reviewer plan_tsidp_probe_sol61 ACKed exact signed
dd28a8398699e6b790ab29616ad07a15d52c1a02 against served ec16: optional storage
fallback is sound; normalized coalescing, response clones and pending cleanup
remain unchanged; original network error is preserved. Reviewer diff-check
passed; 31 runtime fixtures are owner-run diagnostics, not a duplicate review run.

## Small source qualification, only after producer admission

In the exact clean app checkout with pinned tooling, the root producer can run:

```text
nix develop --no-write-lock-file --command just \
  --justfile /absolute/reviewed-adapter/scripts/qualify-runtime-cache.just \
  qualify /absolute/clean-app \
  dd28a8398699e6b790ab29616ad07a15d52c1a02
```

The helper checks app HEAD/cleanliness and invokes only standalone local
//src/lib/sw:sw_test. Record app SHA, helper SHA, exact command, exit/log/test count,
and local execution provenance. It is not GF/RBE proof. The producer owns memory,
CPU, scratch headroom and job lifecycle; this helper does not admit itself or
displace Mship. No build, browser, publication or cluster action was launched.

## Real service-worker acceptance, separate future bounded browser job

Require an image/bundle made from the accepted exact cache candidate, its digest
and worker asset hash, a fresh browser profile, and service workers allowed.
Use the root producer's explicit admission after the writer and freeze the source.

1. Prove registration, activation and controller ownership of the current worker;
   waiting/registration-only is insufficient. Check current app-shell version and
   retention of intended runtime buckets. Provider-denied image captures that block
   workers are not this evidence.
2. Use a same-origin controlled fixture boundary in front of the actual image for
   the exact existing runtime URL shapes. Never let a refresh spill into real
   OpenAQ/WMS/CAMS traffic, keys or paid quota. Name all returned data synthetic;
   real provider availability is a separate lane.
3. Prime one normalized raster/atmospheric fixture, then offline/read the same and
   query-order-equivalent URLs. Confirm cached bytes remain visible; different
   semantic parameter values and buckets must remain separate.
4. Expire/seed unknown-age metadata, resume online against a changed fixture and
   demonstrate one refresh per normalized key, updated bytes, truthful origin Age,
   storedAt and decoded byte count. Failed refresh returns labelled stale bytes
   without rewriting source observation or original write times.
5. Simulate open/match denial and put quota failure with the browser harness;
   online successful data/navigation must remain usable. If both network/cache
   fail, preserve the real network failure and make no offline-data promise.
6. Capture cache inspector/user-visible stale/fresh state and application errors,
   not headers alone. Preserve evidence for actual 32 MiB eviction separately;
   synthetic thrown quota errors do not prove physical mobile storage pressure.

Acceptance must explicitly separate worker lifecycle, fixture cache correctness,
user-visible freshness and real provider measurements. Avoid claiming current
station PM2.5 from marker metadata, CAMS model values as observed readings, or
styled/palette-derived radiance. No broad provider replacement is required for
this six-regression storage-availability fix.
