#!/usr/bin/env bash
# Check spoke conformance with docs/CI-SCHEMA.md §11 checklist.
#
# Exit 0 if all mechanical checks pass; non-zero with a checklist of
# failures otherwise. Items not mechanically verifiable (org ruleset
# membership, tailnet DNS reachability) are flagged as MANUAL.
#
# Usage: scripts/check-conformance.sh [--strict]
#   --strict  treat MANUAL items as failures (default: warn)

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

STRICT=0
if [[ "${1:-}" == "--strict" ]]; then STRICT=1; fi

pass=0
fail=0
manual=0

ok() { printf "  ✓ %s\n" "$1"; pass=$((pass+1)); }
no() { printf "  ✗ %s\n" "$1"; fail=$((fail+1)); }
man() {
  if (( STRICT )); then no "MANUAL (strict): $1"; else
    printf "  ⚠ MANUAL: %s\n" "$1"; manual=$((manual+1));
  fi
}

echo "Conformance check (see docs/CI-SCHEMA.md §11)"
echo

# 1. lanes.json exists and validates
if [[ -f .github/lanes.json ]]; then
  set +e
  python3 scripts/validate-lanes.py >/dev/null 2>&1
  rc=$?
  set -e
  case $rc in
    0) ok ".github/lanes.json validates against lanes.schema.json" ;;
    2) man ".github/lanes.json validator unavailable (jsonschema missing — install via D3 PR2 flake.nix expansion)" ;;
    *) no ".github/lanes.json fails schema validation (run just lanes-validate for details)" ;;
  esac
else
  no ".github/lanes.json is missing"
fi

# 2. ci.yml pins ci-templates by SemVer
if [[ -f .github/workflows/ci.yml ]]; then
  if grep -qE 'tinyland-inc/ci-templates[^@]*@(v[0-9]+\.[0-9]+\.[0-9]+|[0-9a-f]{40})' .github/workflows/ci.yml; then
    ok ".github/workflows/ci.yml pins ci-templates by SemVer or sha"
  elif grep -qE 'tinyland-inc/ci-templates' .github/workflows/ci.yml; then
    no ".github/workflows/ci.yml references ci-templates but not via SemVer pin"
  else
    man "ci.yml does not reference ci-templates yet (pre-cutover OK)"
  fi
else
  no ".github/workflows/ci.yml is missing"
fi

# 3 & 4. Org ruleset + required checks
man "Org ruleset tinyland-spoke-default imported (verify: gh api repos/{owner}/{repo}/rulesets)"
man "Required status checks per §8 configured at the repo level"

# 5. flywheel_target_classes subset of proved allowlist
if [[ -f .github/lanes.json ]]; then
  allowed='sveltekit-app-build sveltekit-unit-tests deployment-bundle-packaging docs-site-static-build web-playwright-chromium-static-smoke'
  bad=""
  while IFS= read -r cls; do
    if [[ -n "$cls" ]] && ! echo " $allowed " | grep -q " $cls "; then
      bad="$bad $cls"
    fi
  done < <(jq -r '[(.defaults.flywheel_target_classes // [])[], (.lanes[]?.flywheel_target_classes // [])[]] | .[]' .github/lanes.json 2>/dev/null | sort -u)
  if [[ -z "$bad" ]]; then
    ok "flywheel_target_classes (if any) are within the proved allowlist"
  else
    no "flywheel_target_classes contains non-allowlisted entries:$bad"
  fi
fi

# 6. No runs-on: ubuntu-latest in artifact / state / bazel jobs.
# Allowed on ubuntu-latest: secrets-scan, lane-dispatch dispatcher, pulse-ingest
# wrapper, cloudflare/vercel/netlify external-publication deploys (need vendor
# API egress, can't realistically live on self-hosted ARC). Flagged: any job
# whose key matches bazel-*, build*, publish-image, tofu-*, test-e2e, or
# flywheel-*.
if [[ -d .github/workflows ]]; then
  offenders=""
  while IFS= read -r f; do
    # Only flag if file declares a non-exempt job AND that job uses ubuntu-latest.
    if grep -qE '^\s*(bazel-[a-z]+|build-[a-z]+|publish-image|tofu-[a-z]+|flywheel-[a-z]+):' "$f"; then
      if grep -qE '^\s*runs-on:\s*ubuntu-latest\b' "$f"; then
        offenders="$offenders $f"
      fi
    fi
  done < <(ls .github/workflows/*.yml 2>/dev/null)
  if [[ -z "$offenders" ]]; then
    ok "No runs-on: ubuntu-latest in artifact/bazel/state jobs"
  else
    # Pre-D3 PR6 cutover state is tolerated; once ci-templates pin lands,
    # promote this to a hard fail.
    if grep -qE 'tinyland-inc/ci-templates[^@]*@v[0-9]+\.[0-9]+\.[0-9]+' .github/workflows/ci.yml 2>/dev/null; then
      no "runs-on: ubuntu-latest found in artifact-shaped jobs:$offenders"
    else
      man "runs-on: ubuntu-latest in artifact-shaped jobs:$offenders (acceptable pre-D3 PR6 cutover)"
    fi
  fi
fi

# 7. Justfile honors --local / LOCAL / FLYWHEEL
if [[ -f Justfile ]]; then
  if grep -qE '(FLYWHEEL|LOCAL|--local)' Justfile; then
    ok "Justfile exposes --local / LOCAL / FLYWHEEL escape hatch"
  else
    man "Justfile lacks an explicit --local escape-hatch reference (pre-D3 PR3 OK)"
  fi
fi

# 8. No rustfs *as state authority*. Descriptive prose (e.g. "never rustfs")
# in schemas/docs is fine; flag only actual state-backend wiring such as
# `rustfs://`, `backend "rustfs"`, or `endpoint = "rustfs...`.
if grep -rqE '(rustfs://|backend\s+"rustfs"|endpoint\s*=\s*"rustfs)' \
     --include='*.tf' --include='*.json' --include='*.yml' --include='*.yaml' --include='Justfile' \
     --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null; then
  no "rustfs state-backend wiring found in repo (forbidden per §5 invariants)"
else
  ok "No rustfs state-backend wiring in repo"
fi

# 9. No OpenTofu in flywheel_target_classes (already covered by item 5)
ok "OpenTofu target-class check (subsumed by allowlist check)"

# 10. image_repository pattern
if [[ -f .github/lanes.json ]]; then
  img=$(jq -r '.spoke.image_repository // empty' .github/lanes.json)
  if [[ -z "$img" ]]; then
    ok "spoke.image_repository unset (default ghcr.io/<owner>/<spoke.name> resolved at workflow time)"
  elif echo "$img" | grep -qE '^ghcr\.io/[a-z0-9._-]+/[a-z0-9._-]+$'; then
    ok "spoke.image_repository matches ghcr.io/<owner>/<repo>"
  else
    no "spoke.image_repository does not match ghcr.io/<owner>/<repo>: $img"
  fi
fi

# 11. Tailnet DNS — manual
man "Tailnet DNS for each lane resolves to a runner-reachable address"

# 12. AGENTS.md cites scaffold tag
if grep -qE 'site\.scaffold|scaffold (tag|version|@v[0-9])|spawned from' AGENTS.md 2>/dev/null \
   && grep -qE '\b(tag|spawned from|conforms to)\b' AGENTS.md 2>/dev/null; then
  ok "AGENTS.md cites the scaffold tag/spawning point"
else
  man "AGENTS.md cites the scaffold tag the repo conforms to (pre-D3 PR7 OK)"
fi

echo
echo "summary: ${pass} pass, ${fail} fail, ${manual} manual"
if (( fail > 0 )); then exit 1; fi
exit 0
