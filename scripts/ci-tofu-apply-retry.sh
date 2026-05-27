#!/usr/bin/env bash
set -euo pipefail

planfile="${1:-darkmap.tfplan}"
log_path="${TOFU_APPLY_LOG:-tofu-apply.log}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci-tofu-guardrails.sh
source "$script_dir/ci-tofu-guardrails.sh"
rm -f "$log_path"

run_apply() {
	tofu apply -auto-approve "$planfile" 2>&1 | tee -a "$log_path"
	return "${PIPESTATUS[0]}"
}

echo "OpenTofu apply attempt 1" | tee -a "$log_path"
set +e
run_apply
apply_status="$?"
set -e

if [[ "$apply_status" == "0" ]]; then
	exit 0
fi

if tofu_guardrail_is_state_error "$log_path"; then
	echo "::warning::OpenTofu apply hit a RustFS/S3 state reopen error; reinitializing backend and retrying once."
	TOFU_INIT_LOG="${TOFU_APPLY_REINIT_LOG:-tofu-apply-reinit.log}" \
		"$script_dir/ci-tofu-init-retry.sh" -backend-config=backend.hcl -reconfigure
	echo "OpenTofu apply attempt 2 after backend reinitialize" | tee -a "$log_path"
	set +e
	run_apply
	retry_status="$?"
	set -e
	if [[ "$retry_status" != "0" ]]; then
		tofu_guardrail_emit_failure "OpenTofu apply retry failed" "$log_path"
	fi
	exit "$retry_status"
fi

tofu_guardrail_emit_failure "OpenTofu apply failed" "$log_path"
exit "$apply_status"
