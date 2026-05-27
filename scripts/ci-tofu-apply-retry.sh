#!/usr/bin/env bash
set -euo pipefail

planfile="${1:-darkmap.tfplan}"
log_path="${TOFU_APPLY_LOG:-tofu-apply.log}"
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

if grep -Eq 'NoSuchBucket|ListObjectsV2|error loading state: S3 bucket does not exist' "$log_path"; then
	echo "::warning::OpenTofu apply hit a RustFS/S3 state reopen error; reinitializing backend and retrying once."
	tofu init -backend-config=backend.hcl -reconfigure
	echo "OpenTofu apply attempt 2 after backend reinitialize" | tee -a "$log_path"
	run_apply
	exit "$?"
fi

exit "$apply_status"
