#!/usr/bin/env bash
set -euo pipefail

log_path="${TOFU_INIT_LOG:-tofu-init.log}"
max_attempts="${TOFU_INIT_MAX_ATTEMPTS:-3}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci-tofu-guardrails.sh
source "$script_dir/ci-tofu-guardrails.sh"
rm -f "$log_path"

if ! [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
	echo "::error::TOFU_INIT_MAX_ATTEMPTS must be a positive integer"
	exit 2
fi

run_init() {
	tofu init "$@" 2>&1 | tee -a "$log_path"
	return "${PIPESTATUS[0]}"
}

is_backend_state_error() {
	tofu_guardrail_is_state_error "$log_path"
}

args=("$@")
has_reconfigure="false"
for arg in "${args[@]}"; do
	if [[ "$arg" == "-reconfigure" || "$arg" == "-reconfigure=true" ]]; then
		has_reconfigure="true"
	fi
done

attempt=1
init_status=0
while (( attempt <= max_attempts )); do
	attempt_args=("${args[@]}")
	if (( attempt > 1 )) && [[ "$has_reconfigure" != "true" ]]; then
		attempt_args=("-reconfigure" "${attempt_args[@]}")
	fi

	echo "OpenTofu init attempt ${attempt}" | tee -a "$log_path"
	set +e
	run_init "${attempt_args[@]}"
	init_status="$?"
	set -e

	if [[ "$init_status" == "0" ]]; then
		exit 0
	fi

	if ! is_backend_state_error; then
		tofu_guardrail_emit_failure "OpenTofu init failed" "$log_path"
		exit "$init_status"
	fi

	if (( attempt < max_attempts )); then
		echo "::warning::OpenTofu init hit a RustFS/S3 backend state error; retrying with backend reconfigure."
	fi
	attempt=$((attempt + 1))
done

tofu_guardrail_emit_failure "OpenTofu init retry exhausted after ${max_attempts} attempt(s)" "$log_path"
exit "$init_status"
