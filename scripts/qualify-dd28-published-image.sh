#!/usr/bin/env bash
set -euo pipefail
# Invoked ONLY inside root-reviewed lowering tinyland-heavy scope after fresh GO.
adapter=/srv/cache/jess/qualification/darkmap-sw-adapter-baac0da
library=/srv/cache/jess/qualification/darkmap-ec16b51-source
artifacts=/srv/cache/jess/qualification/darkmap-dd28a83-artifacts/published-ddd4202-registration-diagnostic
source_sha=dd28a8398699e6b790ab29616ad07a15d52c1a02
digest=sha256:ddd420222bb6e7fc3a0aeacb77564903ba6295fe1bf81fb6fd02163d72df71f6
image=ghcr.io/jesssullivan/darkmap.phasi.space@$digest
export PATH=/nix/store/6x6v11xjf0psckgqmyhfyhw9bdma0rn6-nodejs-22.22.2/bin:/nix/store/vr4agmy8jw7f8kqynpizagdaqxy0ayw4-just-1.50.0/bin:$PATH
export CHROME_BIN=/nix/store/b5chknh5501v96xipynfdyfxjvn55jbw-chromium-147.0.7727.116/bin/chromium
export FONTCONFIG_FILE=/nix/store/37d1hj8wrdgbh64qy6v8h877x78i5ckj-fonts.conf
export NODE_OPTIONS=--max-old-space-size=1536
cid=''
owner=darkmap-dd28-cache-qualification-20261006
[[ ! -e "$artifacts" ]] || { echo 'Refuse existing artifact path' >&2; exit 2; }
mkdir -p "$artifacts"
exec > >(tee "$artifacts/runner.log") 2>&1
cleanup() {
  code=$?
  trap - EXIT
  if [[ -n "$cid" ]]; then
    actual_owner=$(podman inspect --format '{{ index .Config.Labels "tinyland.operator.owner" }}' "$cid" 2>/dev/null || true)
    if [[ "$actual_owner" == "$owner" ]]; then
      podman logs "$cid" > "$artifacts/container.log" 2>&1 || true
      podman stop --time 10 "$cid" || true
      podman rm "$cid" || true
    else printf 'Refuse cleanup: captured container ownership differs\n' >&2; code=1; fi
  fi
  printf 'terminal_exit=%s finished=%s\n' "$code" "$(date -u +%FT%TZ)"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
printf 'app=%s image=%s adapter=baac0dadbf4cde773ca4eb1dd6b01bc676e36bc5 started=%s\n' "$source_sha" "$image" "$(date -u +%FT%TZ)"
cat /proc/self/cgroup
sha256sum "$adapter/scripts/smoke-real-service-worker.mjs" "$adapter/scripts/smoke-published-image.mjs"
podman pull "$image"
revision=$(podman image inspect --format '{{ index .Labels "org.opencontainers.image.revision" }}' "$image")
[[ "$revision" == "$source_sha" ]] || { echo 'OCI source revision mismatch' >&2; exit 1; }
podman image inspect "$image" > "$artifacts/image-inspect.json"
cid=$(podman run -d --memory=512m --memory-swap=512m --pids-limit=256 --label "tinyland.operator.owner=$owner" -p 127.0.0.1::3000 "$image")
printf '%s\n' "$cid" > "$artifacts/container-id.txt"
podman inspect "$cid" > "$artifacts/container-inspect.json"
port=$(podman port "$cid" 3000/tcp)
[[ "$port" =~ ^127\.0\.0\.1:[0-9]+$ ]] || { echo 'Expected loopback-only container port' >&2; exit 1; }
base=http://$port
# Finite readiness polling, not a browser race workaround.
ready=0
for attempt in {1..30}; do
  if node -e 'fetch(process.argv[1]).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' "$base/healthz"; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo 'Image health did not become ready' >&2; exit 1; }
timeout --signal=TERM --kill-after=15s 240s just --justfile "$adapter/Justfile" smoke-real-service-worker "$library" "$base" "$artifacts/sw" "$source_sha" "$digest"
timeout --signal=TERM --kill-after=15s 240s just --justfile "$adapter/Justfile" smoke-published-image "$library" "$base" "$artifacts/ui" "$source_sha" "$digest"
find "$artifacts/sw" "$artifacts/ui" -type f -exec sha256sum {} \;
