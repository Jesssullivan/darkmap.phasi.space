# Backend block intentionally empty — `tofu init -backend-config=backend.hcl`
# (or `just tofu-init`) supplies bucket / key / endpoint / skip flags from
# `backend.hcl`. Matches the shared tinyland-infra S3-backend convention.
terraform {
  required_version = ">= 1.6.0"
  backend "s3" {}
}
