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
