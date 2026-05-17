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

variable "query_raster_key" {
  description = <<EOT
QueryRaster API key proxied through /api/raster. Source via
TF_VAR_query_raster_key in apply environments — never commit a real
value. The default is a placeholder so `tofu plan` succeeds in dry
runs without leaking a real secret.
EOT
  type        = string
  sensitive   = true
  default     = "PLACEHOLDER-replace-via-TF_VAR_query_raster_key"
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
