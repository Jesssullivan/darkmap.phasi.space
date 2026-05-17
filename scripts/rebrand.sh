#!/usr/bin/env bash
# Per-site rebrand pass for sister sites spawned from tinyland-inc/site.scaffold.
#
# Usage: scripts/rebrand.sh <site.example.com>
#
# Substitutes scaffold placeholder strings with the new site identity:
#   site.scaffold        -> <site.example.com>
#   site_scaffold        -> <site_example_com>   (underscored, for MODULE.bazel)
#   bazel-site (cache)   -> bazel-<site>          (slug)
#
# Idempotent: running twice is a no-op once strings have been replaced.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <site.example.com>" >&2
  exit 64
fi

DOMAIN=$1
UNDERSCORED=$(echo "$DOMAIN" | tr '.-' '_')
SLUG=$(echo "$DOMAIN" | cut -d. -f1)

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if ! grep -rq 'site\.scaffold' --include='*.json' --include='*.md' --include='*.ts' --include='*.js' --include='*.bazel' --include='Justfile' --include='.envrc' --include='.bazelrc' .; then
  echo "no scaffold placeholders detected — already rebranded?" >&2
  exit 0
fi

# Text substitutions across config, doc, and source files.
find . -type f \( \
    -name '*.md' -o -name '*.json' -o -name '*.ts' -o -name '*.js' \
    -o -name '*.bazel' -o -name '.bazelrc' -o -name '.envrc' \
    -o -name 'Justfile' -o -name '*.toml' -o -name '*.svelte' \
    -o -name '*.html' -o -name '*.css' -o -name '*.yml' \
    -o -name '*.yaml' -o -name 'flake.nix' \
  \) \
  -not -path './node_modules/*' -not -path './.git/*' -not -path './build/*' \
  -not -path './.svelte-kit/*' -not -path './pnpm-lock.yaml' \
  -not -path './MODULE.bazel.lock' -not -path './flake.lock' \
  -print0 | xargs -0 sed -i.bak \
    -e "s|site\\.scaffold|${DOMAIN}|g" \
    -e "s|site_scaffold|${UNDERSCORED}|g" \
    -e "s|bazel-site|bazel-${SLUG}|g"

# Clean up sed -i.bak backup files
find . -type f -name '*.bak' -not -path './node_modules/*' -not -path './.git/*' -delete

echo "rebranded scaffold to ${DOMAIN}"
echo "  underscored: ${UNDERSCORED}"
echo "  bazel cache: bazel-${SLUG}"
echo
echo "next:"
echo "  1. Review git diff"
echo "  2. Update README.md and AGENTS.md with brand purpose"
echo "  3. Update src/routes/+page.svelte with the landing page"
echo "  4. gh repo edit --description '...' --homepage 'https://${DOMAIN}'"
echo "  5. just setup && just check && just build"
