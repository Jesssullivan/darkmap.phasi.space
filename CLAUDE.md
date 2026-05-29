# Claude — darkmap.phasi.space sister site

This is the `darkmap.phasi.space` sister site. Read `AGENTS.md` first for the
authoritative operating contract.

Quick reminders:

- Use `just <recipe>` for every operation — do not invoke pnpm/vite/bazelisk
  directly unless extending the Justfile.
- Runs a SvelteKit **adapter-node** server (not a static export): it serves
  the app plus thin proxy/normalization API routes. No runtime DB, no auth at
  the edge, no business data owned — federate via `tinyland.dev` snapshots.
- Skeleton 4.15.2 pinned exact. Tailwind v4 with `skeletonTailwindV4Compat()`
  shim. Do not unpin.
- Bazel registry: `tinyland-inc/bazel-registry` first, then BCR.
- See repo: https://github.com/Jesssullivan/darkmap.phasi.space
