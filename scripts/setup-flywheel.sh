#!/usr/bin/env bash
set -euo pipefail

runner_environment="${GF_ACTION_RUNNER_ENVIRONMENT:-self-hosted}"
attic_enabled="${GF_ACTION_ATTIC_ENABLED:-true}"
attic_input="${GF_ACTION_ATTIC_SERVER:-}"
attic_cache="${GF_ACTION_ATTIC_CACHE:-${ATTIC_CACHE:-main}}"
attic_public_key="${GF_ACTION_ATTIC_PUBLIC_KEY:-${ATTIC_PUBLIC_KEY:-}}"
bazel_input="${GF_ACTION_BAZEL_CACHE:-}"
bazel_endpoint=""

write_env() {
	if [ -z "${GITHUB_ENV:-}" ]; then
		echo "::error::GITHUB_ENV is not set; setup-flywheel.sh must run inside GitHub Actions"
		exit 1
	fi

	echo "$1" >>"$GITHUB_ENV"
}

valid_bazel_endpoint() {
	local endpoint="$1"

	if [[ $endpoint == *"\${"* ]] || [[ $endpoint == *"}"* ]]; then
		echo "::warning::Bazel cache endpoint is a literal shell placeholder; ignoring it"
		return 1
	fi

	if [[ $endpoint =~ (attic-cache-dev|fuzzy-dev|attic\.dev-cluster|attic\.tinyland) ]]; then
		echo "::warning::Bazel cache endpoint uses a stale out-of-contract host; ignoring it"
		return 1
	fi

	if [[ ! $endpoint =~ ^(grpc|grpcs|http|https):// ]]; then
		echo "::warning::Bazel cache endpoint must start with grpc://, grpcs://, http://, or https://; ignoring it"
		return 1
	fi

	return 0
}

if [ "$attic_enabled" != "true" ]; then
	echo "::notice::Attic cache hints disabled for this job"
	if [ "$runner_environment" != "github-hosted" ]; then
		bazel_endpoint="${bazel_input:-${BAZEL_REMOTE_CACHE:-grpc://bazel-cache.nix-cache.svc.cluster.local:9092}}"
	else
		bazel_endpoint="${bazel_input:-${BAZEL_REMOTE_CACHE:-}}"
	fi
elif [ "$runner_environment" != "github-hosted" ]; then
	attic_url="${attic_input:-${ATTIC_SERVER:-http://attic.nix-cache.svc.cluster.local}}"
	attic_host="${attic_url#http://}"
	attic_host="${attic_host#https://}"
	attic_host="${attic_host%%/*}"
	attic_host="${attic_host%%:*}"

	if ! command -v getent >/dev/null 2>&1; then
		echo "::warning::getent is unavailable; cannot verify Attic cache DNS ($attic_host)"
	elif getent hosts "$attic_host" >/dev/null 2>&1; then
		write_env "ATTIC_SERVER=$attic_url"
		echo "::notice::Attic cache reachable at $attic_url"
	else
		echo "::warning::Attic cache DNS unreachable ($attic_host); running without Attic cache"
	fi

	bazel_endpoint="${bazel_input:-${BAZEL_REMOTE_CACHE:-grpc://bazel-cache.nix-cache.svc.cluster.local:9092}}"
else
	if [ -n "$attic_input" ]; then
		write_env "ATTIC_SERVER=$attic_input"
	fi

	bazel_endpoint="${bazel_input:-${BAZEL_REMOTE_CACHE:-}}"
fi

if [ "$attic_enabled" = "true" ]; then
	write_env "ATTIC_CACHE=$attic_cache"

	if [ -n "$attic_public_key" ]; then
		write_env "ATTIC_PUBLIC_KEY=$attic_public_key"
	fi
fi

if [ -n "$bazel_endpoint" ] && valid_bazel_endpoint "$bazel_endpoint"; then
	write_env "BAZEL_REMOTE_CACHE=$bazel_endpoint"
	write_env "GF_BAZEL_SUBSTRATE_MODE=shared-cache-backed"
else
	write_env "BAZEL_REMOTE_CACHE="
	write_env "GF_BAZEL_SUBSTRATE_MODE=compatibility-local-only"
fi

if [ -z "${GITHUB_PATH:-}" ]; then
	echo "::warning::GITHUB_PATH is not set; unable to add Nix profile paths"
	exit 0
fi

for nixbin in /nix/var/nix/profiles/default/bin "$HOME/.nix-profile/bin"; do
	if [ -d "$nixbin" ]; then
		echo "$nixbin" >>"$GITHUB_PATH"
	fi
done
