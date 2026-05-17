#!/usr/bin/env bash
# Classify the current Bazel cache/executor attachment without running Bazel.

set -euo pipefail

STRICT=false

usage() {
  cat >&2 <<'EOF'
Usage: scripts/cache-attachment-contract.sh [--strict]

Without --strict this reports whether the current shell is local-only,
shared-cache-backed, or executor-backed. With --strict it requires a real
BAZEL_REMOTE_CACHE endpoint before Bazel cache-backed work may run.

Set BAZEL_REMOTE_EXECUTOR only for explicit executor-backed proof. Executor
mode still requires BAZEL_REMOTE_CACHE as the CAS/action-cache authority.
EOF
}

for arg in "$@"; do
  case "${arg}" in
  --strict)
    STRICT=true
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage
    exit 2
    ;;
  esac
done

remote_cache="${BAZEL_REMOTE_CACHE:-}"
remote_executor="${BAZEL_REMOTE_EXECUTOR:-}"
mode="${DARKMAP_BAZEL_SUBSTRATE_MODE:-}"

if [[ -n ${remote_executor} ]]; then
  expected_mode="executor-backed"
elif [[ -n ${remote_cache} ]]; then
  expected_mode="shared-cache-backed"
else
  expected_mode="compatibility-local-only"
fi

if [[ -z ${mode} ]]; then
  effective_mode="${expected_mode}"
else
  effective_mode="${mode}"
fi

context="developer-machine"
if [[ ${GITHUB_ACTIONS:-} == "true" ]]; then
  context="github-actions"
elif [[ -n ${CI:-} ]]; then
  context="ci"
fi

literal_cache=false
if [[ ${remote_cache} == *'${'* ]] || [[ ${remote_cache} == *'}'* ]]; then
  literal_cache=true
fi

literal_executor=false
if [[ ${remote_executor} == *'${'* ]] || [[ ${remote_executor} == *'}'* ]]; then
  literal_executor=true
fi

unsupported_cache=false
if [[ -n ${remote_cache} ]] && [[ ! ${remote_cache} =~ ^(grpc|grpcs|http|https):// ]]; then
  unsupported_cache=true
fi

unsupported_executor=false
if [[ -n ${remote_executor} ]] && [[ ! ${remote_executor} =~ ^(grpc|grpcs|http|https):// ]]; then
  unsupported_executor=true
fi

cat <<EOF
Bazel Cache Attachment
======================
Context:            ${context}
Bazel mode:         ${effective_mode}
Bazel remote cache: ${remote_cache:-unset}
Bazel executor:     ${remote_executor:-unset}
Expected mode:      ${expected_mode}
Strict:             ${STRICT}

Contract:
- cache-backed work gets its endpoint from BAZEL_REMOTE_CACHE
- executor-backed work gets BAZEL_REMOTE_EXECUTOR separately from the cache
- .bazelrc keeps cache/executor endpoints out of checked-in defaults
- empty BAZEL_REMOTE_CACHE means compatibility-local-only
EOF

if [[ ${effective_mode} != "${expected_mode}" ]]; then
  echo
  echo "ERROR: DARKMAP_BAZEL_SUBSTRATE_MODE=${effective_mode} disagrees with endpoint presence."
  exit 1
fi

if [[ ${literal_cache} == "true" ]]; then
  echo
  echo "ERROR: BAZEL_REMOTE_CACHE is a literal shell placeholder, not a real endpoint."
  exit 1
fi

if [[ ${literal_executor} == "true" ]]; then
  echo
  echo "ERROR: BAZEL_REMOTE_EXECUTOR is a literal shell placeholder, not a real endpoint."
  exit 1
fi

if [[ ${unsupported_cache} == "true" ]]; then
  echo
  echo "ERROR: BAZEL_REMOTE_CACHE must start with grpc://, grpcs://, http://, or https://."
  exit 1
fi

if [[ ${unsupported_executor} == "true" ]]; then
  echo
  echo "ERROR: BAZEL_REMOTE_EXECUTOR must start with grpc://, grpcs://, http://, or https://."
  exit 1
fi

if [[ -n ${remote_executor} && -z ${remote_cache} ]]; then
  echo
  echo "ERROR: executor-backed mode requires BAZEL_REMOTE_CACHE."
  exit 1
fi

if [[ ${STRICT} == "true" && -z ${remote_cache} ]]; then
  echo
  echo "ERROR: strict mode requires BAZEL_REMOTE_CACHE to be set."
  exit 1
fi

echo
echo "Status: ${expected_mode}"
