# Claude — darkmap.tinyland.dev sister site

This is a sister site spawned from `tinyland-inc/darkmap.tinyland.dev`. Read
`AGENTS.md` first for the authoritative operating contract.

Quick reminders:

- Use `just <recipe>` for every operation — do not invoke pnpm/vite/bazelisk
  directly unless extending the Justfile.
- Sites are static. No runtime DB, no auth at the edge — federate via
  `tinyland.dev` snapshots.
- Skeleton 4.15.2 pinned exact. Tailwind v4 with `skeletonTailwindV4Compat()`
  shim. Do not unpin.
- Bazel registry: `tinyland-inc/bazel-registry` first, then BCR.
- See parent: https://github.com/tinyland-inc/darkmap.tinyland.dev
