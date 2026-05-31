#!/usr/bin/env bash

# Shared, public-safe failure surfacing for OpenTofu state backend jobs.

TOFU_GUARDRAILS_ISSUE_URL="${TOFU_GUARDRAILS_ISSUE_URL:-https://github.com/Jesssullivan/darkmap.phasi.space/issues/139}"
TOFU_GUARDRAILS_DETAIL_ISSUE_URL="${TOFU_GUARDRAILS_DETAIL_ISSUE_URL:-https://github.com/Jesssullivan/darkmap.phasi.space/issues/140}"
TOFU_GUARDRAILS_DOC_URL="${TOFU_GUARDRAILS_DOC_URL:-https://github.com/Jesssullivan/darkmap.phasi.space/blob/main/docs/TOFU_STATE_GUARDRAILS.md}"
TOFU_BACKEND_STATE_ERROR_PATTERN="${TOFU_BACKEND_STATE_ERROR_PATTERN:-NoSuchBucket|ListObjectsV2|S3 bucket does not exist|error loading state|Failed to get existing workspaces}"

tofu_guardrail_is_state_error() {
	local log_path="${1:?}"

	[[ -f "$log_path" ]] || return 1
	grep -Eiq "$TOFU_BACKEND_STATE_ERROR_PATTERN" "$log_path"
}

tofu_guardrail_failure_class() {
	local log_path="${1:?}"

	if tofu_guardrail_is_state_error "$log_path"; then
		echo "interim RustFS/S3 state backend"
	else
		echo "OpenTofu"
	fi
}

tofu_guardrail_emit_failure() {
	local title="${1:?}"
	local log_path="${2:?}"
	local failure_class

	failure_class="$(tofu_guardrail_failure_class "$log_path")"

	if [[ "$failure_class" == "interim RustFS/S3 state backend" ]]; then
		echo "::error::${title}: matched RustFS/S3 state symptoms. Capture the evidence artifact before recovery. See ${TOFU_GUARDRAILS_ISSUE_URL} and ${TOFU_GUARDRAILS_DOC_URL}."
	else
		echo "::error::${title}: see ${log_path} and ${TOFU_GUARDRAILS_DOC_URL}."
	fi

	if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
		{
			echo "### OpenTofu state guardrail"
			echo
			echo "- Result: failed"
			echo "- Guardrail: ${title}"
			echo "- Failure class: ${failure_class}"
			echo "- Evidence log: \`${log_path}\`"
			echo "- Tracker: [#139](${TOFU_GUARDRAILS_ISSUE_URL}) / [#140](${TOFU_GUARDRAILS_DETAIL_ISSUE_URL})"
			echo "- Runbook: [Tofu state guardrails](${TOFU_GUARDRAILS_DOC_URL})"
		} >>"$GITHUB_STEP_SUMMARY"
	fi
}
