# Claude — darkmap.phasi.space

Read `AGENTS.md` first — it is the authoritative operating contract. This file is
only the handful of reminders worth keeping in context every session:

- Use `just <recipe>` for every operation; don't invoke pnpm/vite/bazelisk directly
  unless you're extending the Justfile.
- Never run browserful Playwright e2e locally (`just test-e2e` needs `LOCAL=1`) — CI's
  e2e lane is the source of truth. Locally use `just check` / `just ci-quick`.
- Skeleton 4.15.2 + Tailwind v4 are pinned exact behind a compat shim — do not upgrade
  them. See `AGENTS.md` §Theme.

Repo: https://github.com/Jesssullivan/darkmap.phasi.space
