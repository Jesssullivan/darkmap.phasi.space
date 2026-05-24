# darkmap.tinyland.dev — namespace + legacy DNS.
#
# The Deployment / Service / Ingress / tailscale-svc are managed via
# Kustomize (infra/kustomize/honey/darkmap/) so kubectl-apply lifecycle
# stays separate from Tofu state.

resource "kubernetes_namespace_v1" "darkmap" {
  metadata {
    name = var.namespace
    labels = {
      "tinyland.dev/site"     = "darkmap.tinyland.dev"
      "tinyland.dev/exposure" = "tailnet-only"
    }
  }
}

# Public CF DNS record pointing at the tailnet `tinyland-ingress` IP. CF
# answers everyone, but only on-tailnet clients can actually route to
# the 100.x.x.x address — same defense-in-depth pattern as tinyland.dev
# itself.
resource "cloudflare_dns_record" "darkmap_a" {
  zone_id = var.cloudflare_zone_id
  name    = "darkmap"
  type    = "A"
  content = var.darkmap_tailnet_ip
  ttl     = 300
  proxied = false
  comment = "darkmap.tinyland.dev tailnet-only (shares tinyland-ingress)"
}

# ─────────────────────────────────────────────────────────────────────
# Spoke-* modules from tinyland-inc/GloriousFlywheel@spoke-tofu-modules-v1.0.0
# Composes the five spoke-facing modules alongside the existing
# Cloudflare + Kubernetes resources above. Per docs/CI-SCHEMA.md §5-7.
#
# Hard invariants honored:
# - State backend stays S3-compatible (rustfs S3 API at
#   attic-rustfs-hl.nix-cache.svc:9000) — NOT a §5 violation; that
#   invariant forbids rustfs as RBE CAS/action-cache, not as a Tofu
#   state S3 backend.
# - rustfs NEVER appears as RBE CAS or action-cache.
# - No OpenTofu RBE.
#
# Every module is `count`-gated on a per-feature boolean variable so
# the cutover can land incrementally — initial apply with all gates
# false is a no-op. Flip each gate as the operator-side preconditions
# are met (Blahaj installed, runner-pool ACL controller deployed,
# external-dns namespace mapping, etc.).
# ─────────────────────────────────────────────────────────────────────

locals {
  # HTTPS (not SSH) so hosted CI runners without an ssh-agent — and
  # without a deploy key for tinyland-inc/GloriousFlywheel — can fetch
  # the modules anonymously. GloriousFlywheel is a public repo, so
  # `git clone https://github.com/...` works with no auth. Surfaced by
  # darkmap M3+M4 PR #77 CI: SSH cloning failed with
  # `Host key verification failed`. Logged as a feedback note in
  # `docs/playbook/scaffold-v1-upgrade.md` §8 Pitfalls.
  spoke_modules_source = "git::https://github.com/tinyland-inc/GloriousFlywheel.git//tofu/modules"
  spoke_modules_ref    = "spoke-tofu-modules-v1.0.0"
}

# S3 prefix + env-reaper IAM. Bucket defaults to "tofu-state"; darkmap's
# rustfs-backed backend at attic-rustfs-hl supplies the actual store.
# reaper_principal_arn left empty until Blahaj is installed on this repo
# (TIN-1384 / lane-env.yml workflow's BLAHAJ_LANE_ENV_ENABLED gate).
module "spoke_state_namespace" {
  count  = var.spoke_state_namespace_enabled ? 1 : 0
  source = "${local.spoke_modules_source}/spoke-state-namespace?ref=${local.spoke_modules_ref}"

  spoke_slug           = "darkmap"
  bucket_name          = var.spoke_state_bucket
  create_reaper_iam    = false
  reaper_principal_arn = ""
}

# Attic + Bazel cache quota declaration for darkmap. Cache services
# (nix-cache namespace on honey) observe this ConfigMap.
module "spoke_cache_quota" {
  count  = var.spoke_cache_quota_enabled ? 1 : 0
  source = "${local.spoke_modules_source}/spoke-cache-quota?ref=${local.spoke_modules_ref}"

  spoke_slug = "darkmap"
  cache_gib  = var.spoke_cache_gib
}

# Runner-class ACL. Hard-deny enforcement: dispatches to classes outside
# allowed_runner_classes are rejected at the runner-pool layer. darkmap's
# bespoke ci.yml dynamic fallback (vars.PRIMARY_LINUX_RUNNER_LABELS_JSON)
# can still land on ubuntu-latest; the spoke-* contract here governs the
# cluster-side dispatch path only.
module "spoke_runner_binding" {
  count  = var.spoke_runner_binding_enabled ? 1 : 0
  source = "${local.spoke_modules_source}/spoke-runner-binding?ref=${local.spoke_modules_ref}"

  spoke_slug             = "darkmap"
  github_repository      = "Jesssullivan/darkmap.tinyland.dev"
  allowed_runner_classes = var.spoke_allowed_runner_classes
  enforcement_mode       = var.spoke_runner_binding_enforcement_mode
}

# Wildcard PR-env DNS via external-dns. Pre-creates *.pr.darkmap.tinyland.dev
# so Blahaj doesn't need DNS provisioning rights. lane_names is empty by
# default (no stable per-lane DNS); set in tfvars if needed.
module "spoke_dns_pr_env" {
  count  = var.spoke_dns_pr_env_enabled ? 1 : 0
  source = "${local.spoke_modules_source}/spoke-dns-pr-env?ref=${local.spoke_modules_ref}"

  spoke_slug     = "darkmap"
  brand_domain   = "darkmap.tinyland.dev"
  lane_names     = var.spoke_stable_lane_names
  ingress_target = var.spoke_ingress_target
}

# Blahaj GitHub App installation. Gated on installation_id > 0 — set to
# the real ID once Blahaj is installed on Jesssullivan/darkmap.tinyland.dev
# and lane-env.yml is enabled (vars.BLAHAJ_LANE_ENV_ENABLED == 'true').
module "spoke_blahaj_app_install" {
  count  = var.spoke_blahaj_installation_id > 0 ? 1 : 0
  source = "${local.spoke_modules_source}/spoke-blahaj-app-install?ref=${local.spoke_modules_ref}"

  spoke_slug        = "darkmap"
  github_repository = "Jesssullivan/darkmap.tinyland.dev"
  installation_id   = var.spoke_blahaj_installation_id
}
