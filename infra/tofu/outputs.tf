output "namespace" {
  description = "The Kubernetes namespace the workload runs in."
  value       = kubernetes_namespace_v1.darkmap.metadata[0].name
}

output "public_dns_record" {
  description = "Managed public Cloudflare record for darkmap.phasi.space, when adopted by this stack."
  value = var.public_dns_enabled ? {
    hostname = var.brand_domain
    content  = cloudflare_dns_record.darkmap_public_cname[0].content
    proxied  = cloudflare_dns_record.darkmap_public_cname[0].proxied
  } : null
}
