variable "namespace" {
  description = "Kubernetes namespace the darkmap workload lives in."
  type        = string
  default     = "darkmap"
}

variable "kubeconfig" {
  description = "Path to the kubeconfig used by the provider."
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "Kubeconfig context targeting the blahaj `honey` cluster."
  type        = string
  default     = "honey"
}

variable "cloudflare_api_token" {
  description = <<EOT
Cloudflare API token with Zone:DNS:Edit on the tinyland.dev zone.
Source via TF_VAR_cloudflare_api_token in apply environments.
EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id for tinyland.dev."
  type        = string
  default     = "3571abd7e73b551e97a3d95cacdb3e39"
}

variable "darkmap_tailnet_ip" {
  description = <<EOT
Tailnet IP the public DNS A record points at. Shared with `tinyland.dev`
itself via the `tinyland-ingress` Tailscale-operator proxy. Off-tailnet
clients can resolve the name but cannot route to the address.
EOT
  type        = string
  default     = "100.125.97.64"
}

# ─────────────────────────────────────────────────────────────────────
# spoke-* module gates (docs/CI-SCHEMA.md §5-7).
#
# All default to false so the initial `tofu apply` is a no-op with
# respect to the schema modules. Flip each to true as operator-side
# preconditions are met. Each gate is documented in main.tf.
# ─────────────────────────────────────────────────────────────────────

variable "spoke_state_namespace_enabled" {
  description = "Provision spoke-state-namespace module (S3 prefix + env-reaper IAM). Default off until Blahaj's reaper principal is known."
  type        = bool
  default     = false
}

variable "spoke_state_bucket" {
  description = "S3-compatible bucket for spoke state. Default matches the tinyland-infra convention."
  type        = string
  default     = "tofu-state"
}

variable "spoke_cache_quota_enabled" {
  description = "Provision spoke-cache-quota module (Attic + Bazel cache declaration ConfigMap). Requires nix-cache namespace + cache services configured to observe per-spoke ConfigMaps."
  type        = bool
  default     = false
}

variable "spoke_cache_gib" {
  description = "Aggregate cache quota in GiB (Attic + Bazel combined). Default 50."
  type        = number
  default     = 50
}

variable "spoke_runner_binding_enabled" {
  description = "Provision spoke-runner-binding module (runner-class ACL ConfigMap). Requires runner-namespace-policy controller to enforce. Set true once the cluster-side ACL controller is observing spoke-* ConfigMaps."
  type        = bool
  default     = false
}

variable "spoke_allowed_runner_classes" {
  description = "Runner classes darkmap may dispatch to. Subset of the master enum at site.scaffold/docs/schemas/lanes.schema.json $defs/runnerClass."
  type        = list(string)
  default     = ["tinyland-nix"]
}

variable "spoke_runner_binding_enforcement_mode" {
  description = "Runner-pool ACL enforcement: deny (default, hard-reject) | warn | dry-run."
  type        = string
  default     = "deny"
}

variable "spoke_dns_pr_env_enabled" {
  description = "Provision spoke-dns-pr-env module (wildcard *.pr.darkmap.tinyland.dev CNAME via external-dns). Requires external-dns deployment configured to watch the spoke namespace."
  type        = bool
  default     = false
}

variable "spoke_stable_lane_names" {
  description = "Stable lane names that get pre-created CNAMEs (e.g. ['staging']). Empty by default — only the wildcard is created."
  type        = list(string)
  default     = []
}

variable "spoke_ingress_target" {
  description = "ExternalName target the wildcard + per-lane CNAMEs resolve to. Typically the cluster ingress controller (e.g. tinyland-ingress.tailnet)."
  type        = string
  default     = "tinyland-ingress.cluster.tinyland.dev"
}

variable "spoke_blahaj_installation_id" {
  description = "Blahaj GitHub App installation ID on Jesssullivan/darkmap.tinyland.dev. Set to a positive integer once Blahaj is installed (gh api /app/installations). Module is skipped when 0."
  type        = number
  default     = 0
}
