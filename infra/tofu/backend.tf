# Backend block intentionally empty — `tofu init -backend-config=backend.hcl`
# (or `just tofu-init`) supplies bucket / key / endpoint / skip flags from
# `backend.hcl`. Matches the tinyland-infra convention (see
# /Users/jess/git/tinyland-infra/tofu/backend/honey.s3.hcl).
terraform {
  required_version = ">= 1.6.0"
  backend "s3" {}
}
