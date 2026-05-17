#!/usr/bin/env bash
# Run Bazel through the explicit darkmap cache/executor attachment path.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: scripts/bazel-cache-backed.sh <command> [args...]

Commands:
  build     Run a cache-backed Bazel build
  test      Run cache-backed Bazel tests
  run       Run a cache-backed Bazel target
  coverage  Run cache-backed Bazel coverage
  info      Validate cache attachment, then run bazel info

Environment:
  BAZEL_REMOTE_CACHE must be a real grpc://, grpcs://, http://, or https:// endpoint.
  BAZEL_REMOTE_EXECUTOR optionally enables executor-backed mode.
  DARKMAP_BAZEL_REMOTE_EXECUTION_PLATFORM optionally sets the executor
    platform property; defaults to gloriousflywheel-rbe-linux-x86_64.
  BAZEL_REPOSITORY_CACHE optionally points at a Bazel repository cache directory.
  BAZEL_DISTDIR optionally contains colon-separated Bazel distdir paths.
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

command="$1"
shift

case "${command}" in
build | test | run | coverage | info) ;;
-h | --help)
  usage
  exit 0
  ;;
*)
  echo "ERROR: unsupported Bazel command for cache-backed wrapper: ${command}" >&2
  usage
  exit 2
  ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
bazel_bin="${BAZEL_BIN:-bazel}"
bazel_prefix_args=()
remote_cache="${BAZEL_REMOTE_CACHE:-}"
remote_executor="${BAZEL_REMOTE_EXECUTOR:-}"
remote_execution_platform="${DARKMAP_BAZEL_REMOTE_EXECUTION_PLATFORM:-gloriousflywheel-rbe-linux-x86_64}"
external_fetch_args=()
executor_args=()

if [[ -n ${BAZEL_REPOSITORY_CACHE:-} ]]; then
  external_fetch_args+=(--repository_cache="${BAZEL_REPOSITORY_CACHE}")
fi

if [[ -n ${BAZEL_DISTDIR:-} ]]; then
  IFS=: read -r -a bazel_distdirs <<<"${BAZEL_DISTDIR}"
  for bazel_distdir in "${bazel_distdirs[@]}"; do
    if [[ -n ${bazel_distdir} ]]; then
      external_fetch_args+=(--distdir="${bazel_distdir}")
    fi
  done
fi

bash "${script_dir}/cache-attachment-contract.sh" --strict

if ! command -v "${bazel_bin}" >/dev/null 2>&1; then
  if command -v bazelisk >/dev/null 2>&1; then
    bazel_bin="bazelisk"
  elif command -v npx >/dev/null 2>&1; then
    bazel_bin="npx"
    bazel_prefix_args=(--yes @bazel/bazelisk)
  else
    echo "ERROR: ${bazel_bin} is not on PATH and npx is unavailable; enter the devshell or install Bazelisk." >&2
    exit 127
  fi
fi

cd "${repo_root}"

case "${command}" in
info)
  exec "${bazel_bin}" "${bazel_prefix_args[@]}" info "${external_fetch_args[@]}" "$@"
  ;;
*)
  bazel_config="ci-cached"
  if [[ -n ${remote_executor} ]]; then
    bazel_config="executor-backed"
    executor_args+=(
      --remote_executor="${remote_executor}"
      --remote_default_exec_properties="gf.platform=${remote_execution_platform}"
    )
  fi

  exec "${bazel_bin}" "${bazel_prefix_args[@]}" "${command}" \
    --config="${bazel_config}" \
    --remote_cache="${remote_cache}" \
    "${executor_args[@]}" \
    "${external_fetch_args[@]}" \
    "$@"
  ;;
esac
