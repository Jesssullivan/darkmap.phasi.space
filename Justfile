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

# Bazel-driven test through the cache-attachment wrapper. Validates
# BAZEL_REMOTE_CACHE / BAZEL_REMOTE_EXECUTOR env first (rejects shell-
# placeholder leaks + bad schemes), then attaches the endpoint only if
# it's real. Used by GF pools that hand off endpoint env per scale-set.
# See scripts/bazel-cache-backed.sh and the MassageIthaca-pattern
# cache-attachment contract.
bazel-test-cached *targets='//...':
    cd {{ root }} && bash scripts/bazel-cache-backed.sh test {{ targets }}

# Cache-attachment contract probe — what mode would bazel run in?
# Prints `compatibility-local-only`, `shared-cache-backed`, or
# `executor-backed` based on env vars (no bazel invocation).
bazel-cache-contract:
    cd {{ root }} && bash scripts/cache-attachment-contract.sh

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

# Operator deploy: apply manifests + rollout-restart so :main pulls the
# newest image + wait for the rollout to settle. Replaces the CI
# staging-deploy when the ARC runner pool can't reach the cluster API
# (the runner pods sit on a network that has no route to the cluster
# tailnet IP — only `kustomize-apply` from a tailnet-joined workstation
# works today). See .github/workflows/staging-deploy.yml header.
deploy: kustomize-apply
    kubectl -n darkmap rollout restart deployment/darkmap
    kubectl -n darkmap rollout status deployment/darkmap --timeout=180s

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

# ─────────────────────────────────────────────
# CI-SCHEMA v1.0 (lanes, flywheel, conformance — see docs/CI-SCHEMA.md)
# ─────────────────────────────────────────────

# Print resolved lanes as a table
lanes-list:
    @cd {{ root }} && jq -r '"NAME\tTRIGGER\tRUNNER\tE2E\tTHEME"' .github/lanes.json
    @cd {{ root }} && jq -r '.lanes[] | [.name, (.trigger // "pull_request"), (.runner_class // "(default)"), (.e2e // false | tostring), .theme] | @tsv' .github/lanes.json | column -t -s $'\t'

# Validate .github/lanes.json against docs/schemas/lanes.schema.json
lanes-validate:
    cd {{ root }} && python3 scripts/validate-lanes.py

# Dry-run construct the Blahaj provision payload for a PR
lane-dispatch pr filter="all":
    cd {{ root }} && python3 scripts/lane-dispatch.py --pr {{ pr }} --filter "{{ filter }}"

# Dry-run construct the Blahaj destroy payload for a PR (set REAP_CONFIRM=1 + pass --dispatch to actually send)
lane-reap pr:
    @cd {{ root }} && read -p "Construct reap payload for PR #{{ pr }}? [y/N] " ans; [ "$ans" = "y" ] || { echo "aborted."; exit 1; }
    cd {{ root }} && python3 scripts/lane-dispatch.py --pr {{ pr }} --reap
    @echo "(dry-run; set REAP_CONFIRM=1 and pass --dispatch to actually send)"

# Run the spoke conformance checklist (docs/CI-SCHEMA.md §11)
conformance:
    cd {{ root }} && bash scripts/check-conformance.sh

# ─────────────────────────────────────────────
# Flywheel (cache-first; executor opt-in; see docs/CI-SCHEMA.md §5)
# Env knob: FLYWHEEL=local|cache|executor|auto (default auto)
#   local     → no remote_* flags at all
#   cache     → --config=flywheel (cache-only)
#   executor  → --config=flywheel-executor (proved-class executor + cache)
#   auto      → probe bazel-cache.nix-cache.svc.cluster.local:9092 reachability;
#               fall through to cache if reachable, local otherwise.
# Coexists with darkmap's existing bazel-test-cached / bazel-cache-contract
# recipes (which use the cache-attachment-contract.sh wrapper for dynamic
# endpoint resolution). Use these recipes when the cluster cache DNS is
# stable; use bazel-test-cached when the endpoint is delivered dynamically.
# ─────────────────────────────────────────────

# Resolved flywheel config flag for the current host (auto-detect by default)
_flywheel-flag:
    @mode="${FLYWHEEL:-auto}"; \
    case "$mode" in \
      local)    echo "" ;; \
      cache)    echo "--config=flywheel" ;; \
      executor) echo "--config=flywheel-executor" ;; \
      auto)     if nc -z -w1 bazel-cache.nix-cache.svc.cluster.local 9092 2>/dev/null; then \
                  echo "--config=flywheel"; \
                else \
                  echo "" >&2; echo "[flywheel] cluster cache unreachable; running pure local" >&2; \
                  echo ""; \
                fi ;; \
      *) echo "[flywheel] unknown FLYWHEEL=$mode (expected local|cache|executor|auto)" >&2; exit 64 ;; \
    esac

# Bazel build via flywheel (defaults to //:node_modules smoke target)
flywheel-build target="//:node_modules":
    @cfg=$(just _flywheel-flag); \
    echo "[flywheel-build] FLYWHEEL=${FLYWHEEL:-auto} → bazelisk build $cfg {{ target }}"; \
    cd {{ root }} && bazelisk build $cfg {{ target }}

# Bazel test via flywheel
flywheel-test target="//...":
    @cfg=$(just _flywheel-flag); \
    echo "[flywheel-test] FLYWHEEL=${FLYWHEEL:-auto} → bazelisk test $cfg {{ target }}"; \
    cd {{ root }} && bazelisk test $cfg {{ target }}

# Remote dev server — v1.1+ stub (see ci-templates/docs/spec/dev-remote.md)
dev-remote lane="default":
    @echo "dev-remote is a v1.1+ stub. Dev servers are explicitly blocked from REAPI"
    @echo "(GloriousFlywheel/config/rbe-target-eligibility.json), so a cluster-side"
    @echo "pnpm dev tunnel requires the lane-preview-tunnel composite action which"
    @echo "ships in ci-templates v1.1+. Track at: tinyland-inc/ci-templates/docs/roadmap.md"
    @exit 2

# Sync vendored .bazelrc.flywheel from a pinned ci-templates tag (placeholder until v1.0.0 ships)
sync-flywheel-bazelrc tag="v1.0.0":
    @echo "sync-flywheel-bazelrc {{ tag }}: ci-templates v1.0.0 not yet released."
    @echo "Once tagged, this recipe will:"
    @echo "  gh api --output - repos/tinyland-inc/ci-templates/contents/bazelrc/flywheel.bazelrc?ref={{ tag }} \\"
    @echo "    | jq -r .content | base64 -d > .bazelrc.flywheel"
    @echo "  and update the header comment to record the tag."
    @exit 2
