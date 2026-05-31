# Claude — darkmap.phasi.space sister site

This is the `darkmap.phasi.space` sister site. Read `AGENTS.md` first for the
authoritative operating contract.

Quick reminders:

- Use `just <recipe>` for every operation — do not invoke pnpm/vite/bazelisk
  directly unless extending the Justfile.
- Runs a SvelteKit **adapter-node** server (app + thin proxy/normalization API
  routes; no DB, no edge auth). See `AGENTS.md` §Build for the architecture
  contract; federate via `tinyland.dev` snapshots.
- Skeleton 4.15.2 pinned exact; Tailwind v4 with `skeletonTailwindV4Compat()`
  shim. See `AGENTS.md` §Theme for the do-not-upgrade guardrails.
- Browserful Playwright e2e and the adapter-node build are **remote-first**:
  locally use `just check` / `just ci-quick`; never run `just test-e2e`
  browserful locally (it requires `LOCAL=1`). CI's e2e lane is the source of
  truth.
- Bazel registry: `tinyland-inc/bazel-registry` first, then BCR.
- See repo: https://github.com/Jesssullivan/darkmap.phasi.space
