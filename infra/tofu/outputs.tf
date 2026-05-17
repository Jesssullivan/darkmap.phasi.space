output "namespace" {
  description = "The Kubernetes namespace the workload runs in."
  value       = kubernetes_namespace_v1.darkmap.metadata[0].name
}

output "upstream_secret_name" {
  description = "Name of the secret holding QUERY_RASTER_KEY."
  value       = kubernetes_secret_v1.darkmap_upstream.metadata[0].name
}
