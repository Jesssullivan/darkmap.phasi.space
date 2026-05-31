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
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }
}

locals {
  rustfs_s3_endpoint = "http://attic-rustfs-hl.nix-cache.svc:9000"
  rustfs_s3_region   = "us-east-1"
}

provider "kubernetes" {
  config_path    = var.kubeconfig
  config_context = var.kube_context
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# The GloriousFlywheel spoke-state module references the AWS provider for
# S3-compatible state/IAM shapes even when the darkmap gates are disabled.
# Keep this provider pointed at RustFS and disable AWS account discovery.
provider "aws" {
  region                      = local.rustfs_s3_region
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_region_validation      = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    s3 = local.rustfs_s3_endpoint
  }
}
