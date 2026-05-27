#!/usr/bin/env bash
set -euo pipefail

log_path="${TOFU_STATE_LIST_LOG:-tofu-state-list.log}"
rm -f "$log_path"

echo "Checking OpenTofu state backend reachability..."
tofu state list >"$log_path"

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
