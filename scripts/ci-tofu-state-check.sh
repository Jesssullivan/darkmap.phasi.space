#!/usr/bin/env bash
set -euo pipefail

log_path="${TOFU_STATE_LIST_LOG:-tofu-state-list.log}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci-tofu-guardrails.sh
source "$script_dir/ci-tofu-guardrails.sh"
rm -f "$log_path"

echo "Checking OpenTofu state backend reachability..."
set +e
tofu state list >"$log_path" 2>&1
state_status="$?"
set -e

if [[ "$state_status" != "0" ]]; then
	cat "$log_path"
	tofu_guardrail_emit_failure "OpenTofu state backend check failed" "$log_path"
	exit "$state_status"
fi

resource_count="$(wc -l <"$log_path" | tr -d ' ')"
echo "OpenTofu state backend reachable; ${resource_count} resource(s) listed."

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
	{
		echo "### OpenTofu state backend check"
		echo
		echo "- Result: reachable"
		echo "- Resources listed: \`${resource_count}\`"
	} >>"$GITHUB_STEP_SUMMARY"
fi
