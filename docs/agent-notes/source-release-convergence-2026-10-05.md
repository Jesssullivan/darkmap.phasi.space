# Source-only release convergence preparation

Authority: root's October 5 source-only retirement follow-up. No runtime, DNS,
deployment, remote push, workflow dispatch or main mutation performed here.
Served ec16/c5ca and signed rollout receipt af018 remain runtime authority.

Live source baseline: remote main4abc169, STAGING_DEPLOY_ENABLED=true, old
Container push-main publishes latest and successful Container triggers staging
whole-stack Kustomize apply. These workflows are byte-identical in servedec16.
Therefore source reconciliation must remove those triggers in the same reviewed
merge that brings ec16 product source to main, not merge ec16 alone first.

This isolated carrier starts at exact servedec16, carries reviewed f369 atomic
CAS adapter, retires staging-deploy.yml entirely, removes Container push/tag
publication and latest/semver tags, permits publication only through manual
candidate/* dispatch, and retains PR build-only checks. Legacy justdeploy now
refuses safely; justdeploy-exact remains image-only UID/RV/prior-image CAS.
Explicit infrastructure recipes remain available but are not release hooks.

Normal recommended route after root review: one PR from this carrier to current
main, normal review/check/merge with exact-main freshness check. Do not merge
ec16 separately or re-enable legacy deployment. Required branch checks observed:
build-and-test, bazel-graph, secrets-scan, browser-rbe-proof (strict). Independent
TIN-5374 remains independent: no rerun/bypass claimed. Local ec16 product proof
does not become remoteCI proof for the successor metadata tree. Publication or
rollout of a new source SHA needs explicit later artifact qualification; main
convergence alone must leave servedec16/c5ca unchanged.

Original implementation's seven unsigned paths and all unrelated open PRs remain
untouched. No branch-protection, default-branch, visibility or repo-variable
change is proposed. Root must authorize any remote source mutation separately.
