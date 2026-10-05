#!/usr/bin/env bash
set -euo pipefail

source_sha=${1:?full qualified source SHA required}
image_digest=${2:?immutable published image digest required}
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected full source SHA' >&2; exit 2; }
[[ "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Expected sha256 image digest' >&2; exit 2; }
[[ "$(git rev-parse HEAD)" == "$source_sha" ]] || { echo 'Checkout differs from qualified source' >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Release checkout must be clean' >&2; exit 2; }
[[ "$(kubectl config current-context)" == honey ]] || { echo 'Expected honey context' >&2; exit 2; }
image_ref="ghcr.io/jesssullivan/darkmap.phasi.space@$image_digest"
revision=$(skopeo inspect --override-os linux --override-arch amd64 --format '{{ index .Labels "org.opencontainers.image.revision" }}' "docker://$image_ref")
[[ "$revision" == "$source_sha" ]] || { echo 'Published image revision differs from qualified source' >&2; exit 2; }

# Metadata only; existing operator registry/kubeconfig custody is reused without printing credentials.
prior_image=$(kubectl -n darkmap get deployment darkmap -o jsonpath='{.spec.template.spec.containers[?(@.name=="app")].image}')
printf 'source=%s prior_image=%s new_image=%s\n' "$source_sha" "$prior_image" "$image_ref"
kubectl -n darkmap set image deployment/darkmap "app=$image_ref"
kubectl -n darkmap rollout status deployment/darkmap --timeout=180s
actual_image=$(kubectl -n darkmap get deployment darkmap -o jsonpath='{.spec.template.spec.containers[?(@.name=="app")].image}')
[[ "$actual_image" == "$image_ref" ]] || { echo 'Deployment image changed during rollout' >&2; exit 1; }
kubectl -n darkmap get pods -l app.kubernetes.io/name=darkmap \
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{range .status.containerStatuses[*]}{.imageID}{" ready="}{.ready}{end}{"\n"}{end}'
printf 'Rollout complete. Verify served application and all three hosts before acceptance.\n'
