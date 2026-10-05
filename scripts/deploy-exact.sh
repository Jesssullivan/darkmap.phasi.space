#!/usr/bin/env bash
set -euo pipefail

source_sha=${1:?full qualified source SHA required}
image_digest=${2:?immutable published image digest required}
expected_uid=${3:?expected Deployment UID required}
expected_prior_image=${4:?expected app image required}
expected_resource_version=${5:?expected Deployment resourceVersion required}
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected full source SHA' >&2; exit 2; }
[[ "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Expected sha256 image digest' >&2; exit 2; }
[[ "$(git rev-parse HEAD)" == "$source_sha" ]] || { echo 'Checkout differs from qualified source' >&2; exit 2; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Release checkout must be clean' >&2; exit 2; }
[[ "$(kubectl config current-context)" == honey ]] || { echo 'Expected honey context' >&2; exit 2; }
image_ref="ghcr.io/jesssullivan/darkmap.phasi.space@$image_digest"
revision=$(skopeo inspect --override-os linux --override-arch amd64 --format '{{ index .Labels "org.opencontainers.image.revision" }}' "docker://$image_ref")
[[ "$revision" == "$source_sha" ]] || { echo 'Published image revision differs from qualified source' >&2; exit 2; }

# Metadata only; existing operator registry/kubeconfig custody is reused without printing credentials.
# Require exactly one named app container and the operator's recorded prior state.
# The API server repeats every comparison atomically with the replacement, so a
# concurrent rollout/recreate between this read and patch is refused, not overwritten.
deployment=$(kubectl -n darkmap get deployment darkmap -o json)
patch=$(jq -ce --arg uid "$expected_uid" --arg image "$expected_prior_image" \
  --arg rv "$expected_resource_version" --arg next "$image_ref" '
  if .metadata.uid != $uid or .metadata.resourceVersion != $rv then
    error("Deployment identity/version differs from expected state")
  else . end |
  [.spec.template.spec.containers | to_entries[] | select(.value.name == "app")] as $apps |
  if ($apps | length) != 1 then error("Expected exactly one named app container")
  elif $apps[0].value.image != $image then error("App image differs from expected prior image")
  else ($apps[0].key | tostring) as $index |
    [
      {op:"test", path:"/metadata/uid", value:$uid},
      {op:"test", path:"/metadata/resourceVersion", value:$rv},
      {op:"test", path:("/spec/template/spec/containers/" + $index + "/name"), value:"app"},
      {op:"test", path:("/spec/template/spec/containers/" + $index + "/image"), value:$image},
      {op:"replace", path:("/spec/template/spec/containers/" + $index + "/image"), value:$next}
    ]
  end' <<< "$deployment")
printf 'source=%s deployment_uid=%s resource_version=%s prior_image=%s new_image=%s\n' \
  "$source_sha" "$expected_uid" "$expected_resource_version" "$expected_prior_image" "$image_ref"
kubectl -n darkmap patch deployment darkmap --type=json -p "$patch"
kubectl -n darkmap rollout status deployment/darkmap --timeout=180s
actual_image=$(kubectl -n darkmap get deployment darkmap -o jsonpath='{.spec.template.spec.containers[?(@.name=="app")].image}')
[[ "$actual_image" == "$image_ref" ]] || { echo 'Deployment image changed during rollout' >&2; exit 1; }
kubectl -n darkmap get pods -l app.kubernetes.io/name=darkmap \
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{range .status.containerStatuses[*]}{.imageID}{" ready="}{.ready}{end}{"\n"}{end}'
printf 'Rollout complete. Verify served application and all three hosts before acceptance.\n'
