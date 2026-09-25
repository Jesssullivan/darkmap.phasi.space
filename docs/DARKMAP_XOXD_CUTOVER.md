# darkmap.xoxd.ai cutover

`darkmap.xoxd.ai` is Darkmap's new canonical web identity. This document is a
reviewable deployment plan, not evidence that the hostname is live. Keep
`darkmap.phasi.space` public and `darkmap.tinyland.dev` tailnet-reachable during
the migration; neither is redirected or removed by this change. The GitHub
repository, GHCR image, Kubernetes namespace/Service/Deployment selectors, and
OpenTofu state key retain their current identities.

## Verified starting point (2026-09-22, 19:55 UTC)

- `darkmap.phasi.space` resolved to Cloudflare edge addresses and returned
  HTTPS 200 with `server: cloudflare`.
- `darkmap.tinyland.dev` resolved to `100.125.97.64` and returned HTTPS 200 on
  the tailnet route.
- `darkmap.xoxd.ai` had no public DNS answer and could not be reached over
  HTTPS. `xoxd.ai` delegates to Cloudflare nameservers.
- A TLS SNI probe for `darkmap.xoxd.ai` against one current `xoxd.ai`
  Cloudflare edge address returned a certificate with `*.xoxd.ai` and
  `xoxd.ai` SANs. This supports edge-certificate coverage, but does not prove
  the hostname's DNS, tunnel route, or served application.
- In `honey`, `Deployment/darkmap` was Ready 2/2 with
  `ghcr.io/jesssullivan/darkmap.phasi.space:a0ca098`. `Service/darkmap` serves
  port 80. `Ingress/darkmap` and Ready `Certificate/darkmap-tls` cover only
  `darkmap.phasi.space` and `darkmap.tinyland.dev`.
- The live `letsencrypt-prod` ClusterIssuer DNS-01 selector covers
  `tinyland.dev` and `phasi.space`, **not** `xoxd.ai`.

These are point-in-time observations. Repeat the reads before applying a
cutover; do not treat this document as a current cluster-state assertion.

## Ownership and prerequisites

| Surface | Current owner / dependency |
| --- | --- |
| App/image | This repo's adapter-node `Containerfile`, `container.yml`, `staging-deploy.yml`, and `infra/kustomize/honey/darkmap/`. The current image name is deliberately unchanged. `OPENAQ_API_KEY` remains the existing optional server-side `darkmap-secrets` key; `ghcr-registry` remains the image-pull Secret. |
| Existing host DNS | This repo's `infra/tofu/main.tf` manages the legacy `darkmap.tinyland.dev` A record. Its `darkmap.phasi.space` CNAME is **default-off** (`public_dns_enabled`), because that live record has not been adopted into this state. Do not import, replace, or repoint those resources as part of the new-host launch. |
| New-host DNS | The `xoxd.ai` zone is delegated to Cloudflare, but the specific DNS record's infrastructure owner and zone-scoped edit credential have **not** been confirmed. The existing Darkmap `TF_VAR_cloudflare_api_token` contract names the `tinyland.dev` and `phasi.space` zones, not `xoxd.ai`; do not assume it has authority. Resolve ownership and verify the record is absent before creating one proxied `darkmap` CNAME to the existing `honey-ingress` tunnel target. |
| Public tunnel | `honey-ingress` is token-managed. Its remote `config.ingress[]` array is the live public-hostname map, not this repo's nginx Ingress. The house reviewed-intent and operator pattern is `tinyland-inc/blahaj` `tofu/intent/` plus `tofu/scripts/merge-public-edge-ingress.jq` and `docs/runbooks/forms-route-apply.md`. The existing tunnel target is named in this repo's `infra/tofu/variables.tf`; read back the live route/target before use. The protected Cloudflare tunnel credential stays with the operator, outside this repo. |
| TLS | First confirm the new `xoxd.ai` hostname has a valid Cloudflare edge certificate and the tunnel can route **directly** to `http://darkmap.darkmap.svc.cluster.local:80`. That path uses Cloudflare edge TLS and in-cluster HTTP; it does **not** require putting `xoxd.ai` on `Ingress/darkmap` or `darkmap-tls`. If the actual route must pass through nginx HTTPS instead, stop: add a proven `xoxd.ai` DNS-01 solver/credential and a separate TLS plan before editing the existing certificate. Do not append an unissuable SAN to `darkmap-tls`. |
| PR environments | `.github/lanes.json` still names `darkmap.phasi.space`; Blahaj provisioning is not wired per `AGENTS.md`. Changing its domain now would promise unproven PR DNS. This is not a prerequisite for the production hostname. |

## Ordered release

1. Review the exact source head and the normal Darkmap adapter-node build/test
   checks. The static Caddy/image export path used by other sister sites is
   **not** Darkmap's deploy path. Confirm `Container` publishes the existing
   GHCR image and `Staging deploy` pins that image to the same source SHA; a
   published image alone is not a served-site proof.
2. On the cluster, re-read `Service/darkmap`, pod readiness, and the current
   `Ingress/darkmap`/`Certificate/darkmap-tls`. Verify the Cloudflare tunnel's
   existing `darkmap.phasi.space` rule and its actual origin hop. Record a
   rollback snapshot of the remote shared ingress array outside git, mode
   `0600`, before any operator mutation.
3. Land reviewed route intent in the actual `blahaj` owner for
   `darkmap.xoxd.ai -> http://darkmap.darkmap.svc.cluster.local:80`, with no
   Cloudflare Access application if the existing public Darkmap policy is
   intentionally preserved. The operator must verify the service is reachable
   from cloudflared. Merge one rule into the remote tunnel config, retaining
   every existing host and the catch-all last; read it back. Do not replace
   the entire array with a one-host config.
4. Through the confirmed `xoxd.ai` DNS authority, create the proxied
   `darkmap` CNAME to that same tunnel target. Verify public DNS and a valid
   HTTPS response on the new host. Check the edge certificate rather than
   assuming Cloudflare's wildcard coverage is enabled for this zone.
5. Deploy the reviewed Darkmap image through the existing `Container` ->
   `Staging deploy` workflow chain. Check the rollout and served source/image
   identity. Dispatch `Public smoke` with `host=darkmap.xoxd.ai`; confirm the
   homepage, raster proxy, service worker, sitemap, robots, canonical/OG URLs,
   and a real browser map load at the new host. Check both old routes still
   answer. The scheduled smoke remains on `darkmap.phasi.space` until the
   new route has passed its own served-site proof.
6. Only after new-host proof, switch ongoing monitoring and repository homepage
   metadata to `darkmap.xoxd.ai`. Decide separately whether the old public
   host should later redirect; **do not redirect or remove it during this
   launch**. Retain the tailnet route unless a separate operator decision
   retires it.

Rollback is to restore the saved tunnel array and new-host DNS state through
their respective owners, while leaving the existing public and tailnet routes
untouched. If the application image itself regresses, deploy the previous
known-good image via the existing Staging deploy input; do not rewrite the
GHCR package or Kubernetes selector identity.
