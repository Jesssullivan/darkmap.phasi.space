# Agent Notes — darkmap.phasi.space

This file is the working contract for coding agents and LLMs operating in any
sister site spawned from this scaffold.

## Repo Role

This repo is **a static brand/project site under the Tinyland enterprise** —
one of many static projection consumers of the `tinyland.dev` authority
monolith. It is **not** an application backend. It does not own user data,
auth, payments, or business logic. Public content may later flow in through
reviewed static snapshots from `tinyland.dev`.

## Authoritative Entrypoints

- **DX/AX**: `Justfile` is the single source of truth for every operation.
  Always invoke through `just <recipe>`. Do not call `pnpm` / `vite` /
  `bazelisk` directly outside the Justfile unless adding a new recipe.
- **Shell**: `nix develop` (auto-loaded by `direnv`) — never assume host
  toolchain. CI runs `nix develop --command just <recipe>`.
- **Build**: `just build` runs `pnpm run build` (SvelteKit **adapter-node**) and emits a Node server bundle in `build/`. The server hosts the app plus thin proxy/normalization API routes (`/api/raster`, `/api/geocode`, `/api/atmospheric/*`, point-query) — no DB, no auth, no business data owned.
- **Check**: `just check` runs lint, typecheck, and Bazel unit tests.

## Bazel Posture

- Bazel exists for **module-graph integrity proofs** and cache-backed test
  acceleration. The canonical app build remains `pnpm run build`.
- Registry order: `tinyland-inc/bazel-registry` first, then BCR.
- Flywheel profile: `--config=flywheel` (only from runners with cluster
  reachability). In this repo it is a shared remote-cache profile, not a
  Bazel `--remote_executor` proof by itself.
- CI Bazel runner routing uses `BAZEL_LINUX_RUNNER_LABELS_JSON` when set,
  falling back to `PRIMARY_LINUX_RUNNER_LABELS_JSON` and then
  `ubuntu-latest`. When the selected labels include a cache-reachable ARC label
  (`glorious-flywheel`, `jesssullivan-nix`, or `tinyland-nix`), CI sets
  `GF_BAZEL_CONFIG=flywheel`; otherwise hosted fallback runs the same Bazel
  test target without the in-cluster cache profile.
- Tofu plan/apply routing uses `TOFU_LINUX_RUNNER_LABELS_JSON` so RustFS-backed
  state operations can stay on a cluster-DNS-capable runner even when generic
  jobs use hosted runners.
- Smoke: `bazelisk mod graph` and `bazelisk build //:node_modules` run in CI;
  the npm link-tree build adds `--config=flywheel` only on GloriousFlywheel
  runners.
- Unit tests: `just test-unit` runs `bazelisk test //...`; with
  `GF_BAZEL_CONFIG=flywheel` it runs `bazelisk --config=flywheel test //...`.
  Use `just test-local` only as a direct Vitest fallback.

## Remote-first testing

- Browserful Playwright e2e and the adapter-node build are **remote-first**.
  Locally use `just check` / `just ci-quick`; do **not** run `just test-e2e`
  browserful locally — it requires `LOCAL=1`. CI's e2e lane is the source of
  truth.

## Theme & Skeleton

- **Skeleton 4.15.2** (pinned). Do not upgrade casually.
- Tailwind v4 + the `skeletonTailwindV4Compat()` shim plugin in `vite.config.ts`
  rewrites `@variant` / `@apply variant-` to stable equivalents. Do not remove.
- Theme cascade lives in `src/app.css`. Per-site brand themes go under
  `src/lib/styles/themes/`.

## Static Projection

- This site is a **read-only consumer** of reviewed `tinyland.dev` snapshots.
- Static projection ingestion uses checked-in JSON artifacts, not runtime broker
  fetches from the browser or edge.
- Use `just validate-static-projection <snapshot>` before trusting a copied
  snapshot.
- Use `just sync-static-projection <source> <target>` for generic static-spoke
  snapshots.
- Use `just pulse-ingest <source> <target>` for checked-in
  `PublicPulseSnapshot` files.
- These recipes validate static-spoke source authority, content hashes, Pulse
  M1 public shape, secret-shaped field absence, and optional Tinyland brand
  actor public-key readiness. They do not add auth, mutation APIs, checkout
  sessions, payment custody, ActivityPub delivery workers, HTTP-signature
  verification, or public Fediverse federation.
- `.github/workflows/pulse-ingest.yml` is allowed to open checked-in snapshot
  refresh PRs. It must not push directly to the default branch or make the
  generated site fetch Tinyland at browser or edge runtime.

## Per-Site Customization Checklist

After creating a new sister site from this scaffold:

1. `direnv allow`
2. `scripts/rebrand.sh <site.example.com>` — rewrites name strings, env vars,
   bazel cache name, etc.
3. Update `MODULE.bazel` `module(name = ...)` to underscored site name.
4. Update `README.md` / `AGENTS.md` with the per-site brand purpose.
5. Replace `src/routes/+page.svelte` with the brand landing page.
6. Set the GH repo description and homepage URL via `gh repo edit`.
7. Push first commit; verify CI green (secrets-scan, build-and-test, bazel-graph).

## What Not To Do

- Don't add runtime database / API server to a sister site. Keep it static.
- Don't fork tinyland-color-utils / tinyvectors / vite plugins per-site.
  Pin via the BCR.
- Don't bypass `Justfile` in CI or local — DX/AX must stay homogenous.
- Don't unpin Skeleton or Tailwind v4-compat shim without coordination.

## Multi-Lane Posture

- The normative CI + lane contract is [`docs/CI-SCHEMA.md`](./docs/CI-SCHEMA.md).
  Read it before changing `.github/lanes.json`, `.github/workflows/*.yml`,
  any `infra/tofu/` file, or any `flywheel-*` Justfile recipe.
- darkmap runs **one lane** (`default` in `.github/lanes.json`). The lanes
  abstraction is in place so future-darkmap experimentation (e.g., a
  `staging` lane bound to the K8s shadow env) is a one-file edit.
- Lane edits are a one-file change. After editing `.github/lanes.json`,
  run `just lanes-validate` and `just conformance` before committing.
- A three-lane reference is checked in at `.github/lanes.example.json`
  (not loaded by CI — copy fields you need into `lanes.json`).
- This spoke conforms to `tinyland-inc/site.scaffold@feat/ci-schema-d1`
  (commit `e53f2c2`) at adoption time. Bump via a follow-on PR when
  scaffold ships a v1.0 tag.

## Flywheel Binding

The normative Flywheel contract — the two config axes
(`--config=flywheel` cache-only vs `--config=flywheel-executor`
executor+cache), the proved-for-spoke target-class allowlist, and the
hard invariants (no RustFS RBE authority, no OpenTofu RBE, no
devserver RBE, cache hits ≠ RBE) — lives in `docs/CI-SCHEMA.md` §5.
Read it before touching any Flywheel/RBE surface.

**darkmap-specific binding** (not in §5):

- Coexisting with the §5 Flywheel configs, darkmap keeps bespoke
  `--config=ci-cached` and `--config=executor-backed` profiles that use
  `scripts/bazel-cache-backed.sh` for dynamic endpoint resolution (no
  hardcoded URL). Both flows are valid:
  - `--config=flywheel[-executor]` when the cluster cache DNS is stable
    (e.g. running on `tinyland-nix` ARC runners).
  - `--config=ci-cached` / `--config=executor-backed` when the runner
    pool hands out a per-env cache URL via `BAZEL_REMOTE_CACHE`.
- Local DX: `nix develop` for the toolchain, `FLYWHEEL=local|cache|executor|auto`
  env knob picks the bazelrc config for the `just flywheel-build` /
  `just flywheel-test` recipes. `auto` probes cluster cache
  reachability and falls through to pure-local if not on a cluster
  runner.

## Per-PR Ephemeral Envs

- The schema specifies one ephemeral environment per declared lane,
  provisioned via the `tinyland-inc/blahaj` GitHub App
  (`repository_dispatch` payload schema:
  `docs/schemas/blahaj-dispatch.schema.json`).
- DNS naming: `pr-{PR_NUMBER}-{LANE}.darkmap.phasi.space`.
- Image tag template: `pr-{PR_NUMBER}-sha-{COMMIT_SHA}`.
- TTL: default 72h. Per-PR raise via labels `lane-ttl/7d`,
  `lane-ttl/30d`, `lane-ttl/keep` (capped at 720h). Reap on PR close
  + hourly TTL backstop + manual `workflow_dispatch`. Reap is
  idempotent.
- **Blahaj installation status on darkmap: NOT YET WIRED.** The M3
  wrapper (`.github/workflows/lane-env.yml`) is present and pinned to
  `tinyland-inc/ci-templates@v2`, whose optional
  `BLAHAJ_DISPATCH_TOKEN` gate is fork-safe and skips cleanly when the
  token is absent. Actual provision/reap dispatch remains disabled
  until operators set `vars.BLAHAJ_LANE_ENV_ENABLED == 'true'` and add
  the repo secret. Whether Blahaj also gets installed on this repo is
  an operator decision tracked in
  [TIN-1384](https://linear.app/tinyland/issue/TIN-1384).
- Local dry-run available today: `just lane-dispatch <pr>` prints
  the payload Blahaj would receive; `just lane-reap <pr>` does the
  same for destroy (with a confirm prompt; `--dispatch` requires
  `REAP_CONFIRM=1`).

## Tofu Posture

- darkmap's existing `infra/tofu/` is **preserved**. M4
  ([TIN-1385](https://linear.app/tinyland/issue/TIN-1385)) will
  *compose* the five spoke-* modules from
  `tinyland-inc/GloriousFlywheel/tofu/modules/spoke-*` alongside the
  darkmap-specific Cloudflare + Kustomize resources — never replace
  them.
- State backend is S3-compatible: rustfs at
  `attic-rustfs-hl.nix-cache.svc:9000` via the standard S3 API.
  **This is NOT a §5 invariant violation** — that invariant forbids
  rustfs as RBE CAS / action-cache authority, not as a Tofu state
  S3 backend. rustfs exposes an S3-compatible API on `:9000` and
  using it for `terraform.tfstate` is legitimate.
- State key path will move to `spokes/darkmap/terraform.tfstate`
  when M4 lands; current key is per `infra/tofu/backend.hcl`.
- Public HA-state readiness is machine-readable at
  `docs/contracts/ha-opentofu-state-live-candidate-status.json`.
  While #141/TIN-1026 remains blocked on external endpoint provisioning,
  `just tofu-state-ha-readiness --expect-interim` must pass and
  `just tofu-state-ha-readiness` must fail with `NO_LIVE_HA_STATE_CANDIDATE`.
- Protected HA-state migration must follow
  `docs/HA_OPENTOFU_STATE_MIGRATION.md`: generate a reviewable backend config
  first, keep private state snapshots out of git, use OpenTofu backend
  migration, validate the credential boundary and proof checkpoint bundle with
  `just ha-state-credential-boundary-check` and
  `just ha-state-proof-evidence-check`, and verify Tofu apply, GitOps drift, and
  public smoke before closing #145.
- Modules to be composed (post-M4):
  - `spoke-state-namespace` — S3 prefix + reaper IAM.
  - `spoke-dns-pr-env` — wildcard CNAME `*.pr.darkmap.phasi.space`.
  - `spoke-cache-quota` — Attic + Bazel cache allocation.
  - `spoke-runner-binding` — runner-class ACL (hard-deny).
  - `spoke-blahaj-app-install` — only if Blahaj is to be installed.

## Conformance

- `just conformance` runs `scripts/check-conformance.sh` — the
  12-item checklist in `docs/CI-SCHEMA.md` §11. A green run means
  the spoke is house-style compliant. MANUAL items are documented
  below.
- **Ownership gap (Path A)**: darkmap is
  `Jesssullivan/darkmap.phasi.space`, NOT in `tinyland-inc/*`. The
  org-default `tinyland-spoke-default` branch-protection ruleset
  (lives in `tinyland-inc/.github`) does NOT auto-apply to this
  repo. Branch protection is configured manually in
  `Settings → Rules → Rulesets`. Conformance reports this as MANUAL;
  acceptable. (Path B alternative: manually import the ruleset JSON
  via `gh api /repos/Jesssullivan/darkmap.phasi.space/rulesets -X
  POST --input <ruleset.json>` — one-time; updates require
  re-application.)
- **Pre-cutover MANUAL items** (unblock through subsequent
  milestones):
  - `ci.yml` ci-templates pin → M3
    ([TIN-1384](https://linear.app/tinyland/issue/TIN-1384))
  - Tailnet DNS per lane → M6
    ([TIN-1387](https://linear.app/tinyland/issue/TIN-1387)
    validation)
