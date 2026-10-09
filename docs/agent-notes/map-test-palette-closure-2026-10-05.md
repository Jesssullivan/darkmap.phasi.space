# Map test palette closure — 2026-10-05

Authority: operator-approved local qualification for the UI/data release;
R-HOOK-CONVERGENCE-20261004, R-N12/R-N13. Parent is joint source
`30f6ad4ca530a20538d499ca19c158f4a3ad6964`.

Root reported local Bazel services/sw slices passed; map_test passed its other
59 tests but could not collect pm25-style.test.ts because its runtime import
`$lib/atmospheric/aqi` was absent from declared runfiles. The import closure is
pm25-style.test.ts -> pm25-style.ts -> atmospheric/aqi.ts; the latter has no
imports. MapLibre imports in pm25-style.ts are type-only.

Added a one-file public js_library carrier for aqi.ts and declared it in map_srcs.
No all-source glob or complete atmospheric test dependency was added. Source
whitespace and targeted import/label checks pass; root owns the actual Bazel
rerun and immutable combined build/browser/artifact qualification. No package,
lock, page, UI, provider, credential or deployment mutation is included.
