# Agent Notes — darkmap.tinyland.dev

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
- **Build**: `just build` produces a static `build/` (adapter-static).
- **Check**: `just check` runs sync + svelte-check.

## Bazel Posture

- Bazel exists for **module-graph integrity proofs** and future RBE pipeline
  acceleration. The canonical app build remains `pnpm run build`.
- Registry order: `tinyland-inc/bazel-registry` first, then BCR.
- RBE profile: `--config=flywheel` (only from runners with cluster reachability).
- Smoke: `bazelisk mod graph` and `bazelisk build //:node_modules` run in CI.

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

After `gh repo create --template tinyland-inc/darkmap.tinyland.dev`:

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
