# Claude — darkmap.phasi.space

Read `AGENTS.md` first — it is the authoritative operating contract. This file is
only the handful of reminders worth keeping in context every session:

- Use `just <recipe>` for every operation; don't invoke pnpm/vite/bazelisk directly
  unless you're extending the Justfile.
- Never run browserful Playwright e2e locally (`just test-e2e` needs `LOCAL=1`) — CI's
  e2e lane is the source of truth. Locally use `just check` / `just ci-quick`.
- Skeleton 5.0.1 (Zag 1.43.0) + Tailwind v4 are pinned exact; Tailwind consumes
  Skeleton 5 through `@source` in `src/app.css` (the Skeleton 4 compat shim is
  retired). Change them only with a reviewed lock plus browser evidence. See
  `AGENTS.md` §Theme.
- The canonical repo and clone name is `darkmap.phasi.space`. Local clones and
  worktrees named `darkmap.tinyland.dev*` are legacy names for the same repo;
  do not create new ones under that name.

Repo: https://github.com/Jesssullivan/darkmap.phasi.space
