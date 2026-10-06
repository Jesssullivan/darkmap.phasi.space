# dd28 cache Bazel proof — 2026-10-06 UTC

Authority: root's explicit single-target Sting-only qualification approval,
fresh resource-producer admission at 00:41:37 UTC, R-HOOK-CONVERGENCE-20261004,
R-N11/R-N12/R-N13. Mship's next signed writer retained queue priority.

Exact clean app dd28a8398699e6b790ab29616ad07a15d52c1a02 and signed Just helper
41ab6f23f414a413e15aa695ae476d829e4ae332 were qualified; independent tsidp source
ACK remains separate. Source staging preserved the shallow Git boundary needed
to fetch the generated bundle; app HEAD/tree checks passed. Helper file Git blob
80c08c5d5284f8fff7cc015d37266c2834eb6046 matches the signed helper source.

## Execution and terminal evidence

- Start: 2026-10-06 00:46:04 UTC; SSH/tool session 67802.
- Scope: heavy-bash-1791247564-1575788.scope in tinyland-heavy.slice;
  MemoryHigh=3G, MemoryMax=4G, CPUWeight=25.
- Existing pinned tools: Node 22.22.2, Just 1.50.0, Bazelisk 1.28.1 and warm
  Bazel 8.2.1. No Nix realization, GF/remote endpoint or new cache pool.
- Lowering-only adapter: JVM heap 1536 MiB, Node heap 2048 MiB, jobs=1,
  local cpu=1, memory=2048, nocache_test_results, standalone test strategy.
- Target: only //src/lib/sw:sw_test. Invocation
  a467368e-5b1c-4731-bd9c-ee9ac3cc193f.
- Terminal: 00:46:43 UTC, exit 0, elapsed 38.233 s; one Bazel test target
  passed. Its actual Vitest log reports one file and **31/31 tests passed**,
  including the six new storage-availability regressions.
- Runner SHA-256:
  bc30380f85a840a3747fa49d6bfc8a31e32e9450007627bcb78ef850361d511d.
- Full log SHA-256:
  c81f94b9570a28ecc232ab67ccd4e1d8d1c5e2be1a4ceec08c641c87cc31723a.

Logs on Sting:
/srv/cache/jess/qualification/darkmap-dd28a83-artifacts/sw_test.log and the
source's bazel-testlogs/src/lib/sw/sw_test/test.log. Local preserved copies are
in sibling deploy-cas-20261005-artifacts/dd28-sw-test. The complete test log,
not Bazel's wrapper testcase count of one, establishes the 31-test count.

## Headroom and ownership settlement

Immediately before launch, df/statfs agreed on the actual paths:
source/artifacts and existing /srv/cache/jess/bazel/disk_cache plus
repository_cache had 282,324,628 KiB available. The exact workspace outputbase
/srv/fast-local/jess/cache/bazel/output/ad3b5121b895caa7c6933233bf5313e1 had
61,479,044 KiB. No parent-mount-only or quota-escape assumption was used.
Afterward outputbase had 59,620,344 KiB and source/cache had 282,324,552 KiB.

Ownership receipt: data-cache owner | exact dd28 Bazel JVM inside recorded scope |
normal EXIT cleanup after target | R-N11, root-approved owned task |
live owned invocation | native Bazel shutdown completed, no owned JVM/active
heavy scopes at 00:47:00 UTC. Source checkout remained clean. No cross-session
process was signalled. Resource producer received the terminal/slot-release receipt.

This is local hermetic-source qualification, not service-worker browser lifecycle,
provider measurements, publication or runtime acceptance. Real worker activation,
offline/revalidation/storage-pressure browser proof requires separate producer
admission after Mship; no browser, image, push or deploy job was chained.
