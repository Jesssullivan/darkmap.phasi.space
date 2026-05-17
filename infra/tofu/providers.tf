terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.30"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 4.40"
    }
  }
}

provider "kubernetes" {
  config_path    = var.kubeconfig
  config_context = var.kube_context
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
