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
