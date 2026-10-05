# Reversible obsolete workflow retirement receipt

Actor: Darkmap UI/release lane, acting under root's explicit October 5 approval
of the user's scoped retirement/no-automatic-activation/direct-rollout authority.
Target: Jesssullivan/darkmap.phasi.space Actions workflow278160286,
`.github/workflows/staging-deploy.yml` (Staging deploy) only.
Reason: protected main still contains the obsolete Container-success-triggered
whole-stack Kustomize apply, which could overwrite qualified servedec16 while
source-main convergence is pending. This is deployment-hook retirement, not a
CI/branch-protection bypass or transfer of independent TIN-5374 ownership.

Fresh prior state: exact workflow identity/path active; all noncompleted run
queries empty, so no jobs were cancelled or signalled. At2026-10-05T23:33:34Z
normal PUT `/repos/Jesssullivan/darkmap.phasi.space/actions/workflows/278160286/disable`
returned204. Readback: `disabled_manually` at the same exact identity/path.
Re-enable endpoint (operator authorization required): PUT
`/repos/Jesssullivan/darkmap.phasi.space/actions/workflows/278160286/enable`.

Readback: Container278158914 active; CI278138177 active; Browser RBE proof286483584
active. Main still4abc169. Strict required checks build-and-test, bazel-graph,
secrets-scan, browser-rbe-proof and enforce_admins=true unchanged. TIN-5374 still
Backlog/unassigned, updatedOctober3, no tracker mutation/rerun/merge/bypass.
No upstream PR, remote source push, main merge, protection/settings change,
credential action, runtime/DNS/Deployment mutation or Container dispatch occurred.

Effect: future obsolete staging-workflow triggers are suppressed reversibly.
Container's old main/latest publication remains a source-retirement follow-up;
this operation does not imply source-main convergence or fresh RBE evidence.
Servedec16/c5ca and signed rollout receiptaf018 remain runtime authority.
