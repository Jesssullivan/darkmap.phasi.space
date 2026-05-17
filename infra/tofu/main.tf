# darkmap.tinyland.dev — namespace + upstream-key secret.
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

resource "kubernetes_secret_v1" "darkmap_upstream" {
  metadata {
    name      = "darkmap-upstream"
    namespace = kubernetes_namespace_v1.darkmap.metadata[0].name
  }
  type = "Opaque"
  data = {
    QUERY_RASTER_KEY = var.query_raster_key
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
