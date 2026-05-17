output "namespace" {
  description = "The Kubernetes namespace the workload runs in."
  value       = kubernetes_namespace_v1.darkmap.metadata[0].name
}

output "upstream_secret_name" {
  description = "Name of the secret holding QUERY_RASTER_KEY."
  value       = kubernetes_secret_v1.darkmap_upstream.metadata[0].name
}

output "dns_record" {
  description = "Live CF A record for darkmap.tinyland.dev."
  value = {
    hostname = "${cloudflare_dns_record.darkmap_a.name}.tinyland.dev"
    content  = cloudflare_dns_record.darkmap_a.content
    proxied  = cloudflare_dns_record.darkmap_a.proxied
  }
}
