# darkmap.tinyland.dev — SvelteKit static site task runner
# Prerequisites: just, direnv (loads Nix devShell), Nix with flakes
# Quick Start: direnv allow && just setup && just dev
#
# See AGENTS.md.

set dotenv-load := true
set shell := ["bash", "-euo", "pipefail", "-c"]

root := justfile_directory()

# List available commands
_default:
    @just --list --unsorted

# ─────────────────────────────────────────────
# Development
# ─────────────────────────────────────────────

# Install dependencies (frozen lockfile)
setup:
    cd {{ root }} && pnpm install --frozen-lockfile
    @echo "Setup complete. Run 'just dev' to start."

# Start the Vite dev server
dev:
    cd {{ root }} && pnpm run dev

# Start the dev server and open browser
dev-open:
    cd {{ root }} && pnpm run dev -- --open

# ─────────────────────────────────────────────
# Build
# ─────────────────────────────────────────────

# Production static build (adapter-static -> build/)
build:
    cd {{ root }} && pnpm run build

# Clean then build
rebuild: clean build

# Preview the built site
preview: build
    cd {{ root }} && pnpm run preview

# Preview without rebuilding
preview-only:
    cd {{ root }} && pnpm run preview

# Remove build artifacts
clean:
    rm -rf {{ root }}/build {{ root }}/.svelte-kit

# Deep clean including node_modules
clean-all: clean
    rm -rf {{ root }}/node_modules

# ─────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────

# svelte-check + tsc (delegates to package.json `check`)
typecheck:
    cd {{ root }} && pnpm run check

# ESLint flat config across the repo
lint:
    cd {{ root }} && pnpm run lint

# Prettier write
format:
    cd {{ root }} && pnpm run format

# Prettier check (no writes)
format-check:
    cd {{ root }} && pnpm run format:check

# Run unit tests through Bazel. Set GF_BAZEL_CONFIG=flywheel on
# GloriousFlywheel runners to attach to the shared in-cluster Bazel cache.
test-unit:
    cd {{ root }} && if [ "${GF_BAZEL_CONFIG:-}" = "flywheel" ]; then bazelisk test --config=flywheel //...; else bazelisk test //...; fi

# Local Vitest fallback for workstations without cluster cache reachability
test-local:
    cd {{ root }} && pnpm run test:unit

# Local Bazel target validation without the in-cluster flywheel cache
test-bazel-local:
    cd {{ root }} && bazelisk test //src/lib/server/raster:raster_test

# Run Playwright E2E tests
test-e2e:
    cd {{ root }} && pnpm run test:e2e

# Run all tests (Bazel unit + e2e)
test: test-unit test-e2e

# Run lint + typecheck + unit (pre-commit gate)
check: lint typecheck test-unit
    @echo "All checks passed."

# Run full CI pipeline locally
ci: check build test-e2e
    @echo "Full CI suite passed."

# Quick CI (skip e2e + build)
ci-quick: check
    @echo "Quick CI suite passed."

# ─────────────────────────────────────────────
# Static projections
# ─────────────────────────────────────────────

# Validate a checked-in Tinyland static projection snapshot
validate-static-projection snapshot spoke="" actor="":
    cd {{ root }} && args=(scripts/static-projection-snapshot.mts validate "{{ snapshot }}" --expected-source-authority tinyland.dev); \
      if [ -n "{{ spoke }}" ]; then args+=(--expected-spoke "{{ spoke }}"); fi; \
      if [ -n "{{ actor }}" ]; then args+=(--actor-document "{{ actor }}" --expected-actor-id "{{ actor }}" --expected-actor-key-id "{{ actor }}#main-key"); fi; \
      pnpm exec tsx "${args[@]}"

# Copy a reviewed Tinyland static projection snapshot into this repo after validation
sync-static-projection source target spoke="" actor="":
    cd {{ root }} && args=(scripts/static-projection-snapshot.mts sync "{{ source }}" "{{ target }}" --expected-source-authority tinyland.dev); \
      if [ -n "{{ spoke }}" ]; then args+=(--expected-spoke "{{ spoke }}"); fi; \
      if [ -n "{{ actor }}" ]; then args+=(--actor-document "{{ actor }}" --expected-actor-id "{{ actor }}" --expected-actor-key-id "{{ actor }}#main-key"); fi; \
      pnpm exec tsx "${args[@]}"

# Alias for static Pulse snapshot ingestion; still produces a checked-in JSON file only
pulse-ingest source target spoke="" actor="":
    cd {{ root }} && args=(scripts/static-projection-snapshot.mts sync "{{ source }}" "{{ target }}" --expected-source-authority tinyland.dev); \
      if [ -n "{{ spoke }}" ]; then args+=(--expected-spoke "{{ spoke }}"); fi; \
      if [ -n "{{ actor }}" ]; then args+=(--actor-document "{{ actor }}" --expected-actor-id "{{ actor }}" --expected-actor-key-id "{{ actor }}#main-key"); fi; \
      pnpm exec tsx "${args[@]}"

# ─────────────────────────────────────────────
# Utilities
# ─────────────────────────────────────────────

# Sync SvelteKit types
sync:
    cd {{ root }} && pnpm exec svelte-kit sync

# Build with bundle analyzer
analyze:
    cd {{ root }} && BUILD_ANALYZE=true pnpm run build

# Bazel mod graph smoke (registry-resolution proof)
bazel-graph:
    cd {{ root }} && bazelisk mod graph

# ─────────────────────────────────────────────
# Infra — OpenTofu (rustfs S3 state backend)
# ─────────────────────────────────────────────

tofu_dir := root / "infra/tofu"

# Initialize the Tofu working directory + remote state backend
tofu-init:
    cd {{ tofu_dir }} && tofu init -backend-config=backend.hcl

# Re-initialize after backend changes
tofu-init-reconfigure:
    cd {{ tofu_dir }} && tofu init -backend-config=backend.hcl -reconfigure

# Static validation — no network or state access required
tofu-validate:
    cd {{ tofu_dir }} && tofu fmt -check -recursive && tofu validate

# Print the planned diff (non-empty on first run; clean after apply)
tofu-plan:
    cd {{ tofu_dir }} && tofu plan -out=darkmap.tfplan

# Apply the previously-planned changes
tofu-apply:
    cd {{ tofu_dir }} && tofu apply darkmap.tfplan

# Format Tofu sources
tofu-fmt:
    cd {{ tofu_dir }} && tofu fmt -recursive

# ─────────────────────────────────────────────
# Infra — Kustomize (blahaj / honey)
# ─────────────────────────────────────────────

kustomize_dir := root / "infra/kustomize/honey/darkmap"

# Render the kustomize overlay to stdout
kustomize-build:
    kustomize build {{ kustomize_dir }}

# Client-side static validation (no cluster connection required)
kustomize-validate:
    kustomize build {{ kustomize_dir }} | kubectl apply --dry-run=client -f -

# Server-side dry-run (requires kubectl context with cluster access)
kustomize-validate-server:
    kustomize build {{ kustomize_dir }} | kubectl apply --dry-run=server -f -

# Apply the manifests to the cluster
kustomize-apply:
    kustomize build {{ kustomize_dir }} | kubectl apply -f -

# ─────────────────────────────────────────────
# Smoke — offline pre-launch verification (docs/SMOKE.md)
# ─────────────────────────────────────────────

# Offline portion of the launch smoke. Runs check + build, starts the
# adapter-node bundle with a placeholder key on :3055, exercises /
# and /api/raster, asserts no ad/tracking headers leak, and stops.
smoke-local: check build
    #!/usr/bin/env bash
    set -euo pipefail
    if rg -q ad_prebid build/ 2>/dev/null; then echo "FAIL: ad_prebid found in build/" >&2; exit 1; fi
    echo "PASS: no ad_prebid string in build artifact"
    QUERY_RASTER_KEY=PLACEHOLDER_SMOKE PORT=3055 HOST=127.0.0.1 node build/index.js > /tmp/darkmap-smoke.log 2>&1 &
    SERVER_PID=$!
    trap 'kill ${SERVER_PID} 2>/dev/null || true' EXIT
    sleep 2
    INDEX_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3055/)
    if [ "$INDEX_STATUS" != "200" ]; then echo "FAIL: GET / returned $INDEX_STATUS" >&2; exit 1; fi
    echo "PASS: GET / -> 200"
    if curl -s http://127.0.0.1:3055/ | rg -q ad_prebid; then echo "FAIL: ad_prebid in served HTML" >&2; exit 1; fi
    echo "PASS: served HTML clean of ad_prebid"
    RASTER_HEADERS=$(curl -sI 'http://127.0.0.1:3055/api/raster?layer=viirs_2021&qt=tile&qd=8/74/96')
    if echo "$RASTER_HEADERS" | rg -iq 'set-cookie|prebid|googletag|x-ad-'; then
      echo "FAIL: raster response leaked an ad/tracking header" >&2
      echo "$RASTER_HEADERS" >&2
      exit 1
    fi
    echo "PASS: /api/raster response headers free of Set-Cookie / Prebid / googletag / x-ad-*"
    echo
    echo "Local smoke complete. Tailnet smoke is in docs/SMOKE.md."

# Generate changelog (git-cliff)
changelog:
    git-cliff --output CHANGELOG.md

# Preview changelog without writing
changelog-preview:
    git-cliff --unreleased

# Install git hooks (no-op if scripts/hooks/pre-commit absent)
install-hooks:
    @if [ -f {{ root }}/scripts/hooks/pre-commit ]; then \
      ln -sf ../../scripts/hooks/pre-commit {{ root }}/.git/hooks/pre-commit && echo "Git hooks installed."; \
    else \
      echo "No scripts/hooks/pre-commit yet — skipping."; \
    fi

# Show environment info
info:
    @echo "Site:    darkmap.tinyland.dev"
    @echo "Repo:    Jesssullivan/darkmap.tinyland.dev"
    @echo "Node:    $(node --version 2>/dev/null || echo 'not available')"
    @echo "pnpm:    $(pnpm --version 2>/dev/null || echo 'not available')"
    @echo "Just:    $(just --version 2>/dev/null || echo 'not available')"
    @echo "Bazel:   $(if command -v bazelisk >/dev/null 2>&1; then bazelisk --version 2>&1 | head -n1; else echo 'not available'; fi)"
    @echo "Root:    {{ root }}"

# View the GitHub repo (opens in browser)
gh-repo:
    gh repo view Jesssullivan/darkmap.tinyland.dev --web
