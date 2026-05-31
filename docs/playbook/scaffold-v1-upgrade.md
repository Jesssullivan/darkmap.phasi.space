# Scaffold v1 schema upgrade playbook

> **Audience**: spoke maintainers upgrading from the bare
> `tinyland-inc/site.scaffold` template (TIN-1028 batch) to the v1.0
> CI-SCHEMA + ci-templates@v2 + spoke-tofu-modules-v1.0.0 surface.
>
> **Source of truth**: this playbook captures what actually happened
> during darkmap.phasi.space's adoption — the first spoke through the
> upgrade. Subsequent spokes should expect *most* of these steps but
> use the friction notes to anticipate where they'll diverge.
>
> **Linear**: parent [TIN-1381](https://linear.app/tinyland/issue/TIN-1381);
> M1-M6 are sub-issues TIN-1382 through TIN-1387.

---

## 0. Pre-flight checks

Run these BEFORE branching. Each surfaces a constraint that shapes M3 / M4 / M5.

### 0.1 Repo ownership

```bash
git remote get-url origin
```

- **`tinyland-inc/<spoke>`** — org-default ruleset
  (`tinyland-spoke-default`) auto-applies to your default branch via
  the org-level GitHub Rulesets API. Branch protection comes for free.
- **`Jesssullivan/<spoke>`** (or another personal org) — ruleset does
  NOT auto-apply. You'll document this in AGENTS.md (Path A) OR
  import the ruleset JSON manually via `gh api` (Path B). M5 details.

### 0.2 State backend

```bash
grep -E 'endpoint|backend' infra/tofu/backend.hcl infra/tofu/backend.tf 2>/dev/null
```

- **Garage / MinIO / generic S3** — straightforward; matches the
  scaffold's `tofu/backend.tf` template directly.
- **rustfs S3 API** (`http://attic-rustfs-hl.nix-cache.svc:9000` or
  similar) — **NOT a §5 invariant violation**. The CI-SCHEMA §5
  invariant forbids rustfs as RBE CAS / action-cache authority, not
  as a Tofu state S3 backend. rustfs exposes a standard S3-compatible
  API and using it for `terraform.tfstate` is legitimate. Document in
  AGENTS.md (M5) so future readers don't get confused.

### 0.3 Runner shape

```bash
grep -E 'runs-on:' .github/workflows/*.yml | head
```

If your CI already uses a dynamic fallback like
`runs-on: ${{ fromJSON(vars.PRIMARY_LINUX_RUNNER_LABELS_JSON || '["ubuntu-latest"]') }}`,
**M3 will be partial** for you too (see §3 friction). The schema's
`spoke-ci.yml` does NOT yet support dynamic runner-class fallback —
this is the open feedback item from darkmap's cutover.

### 0.4 Blahaj installation

```bash
gh api /repos/<owner>/<spoke>/installation 2>/dev/null | jq -r '.app_slug'
```

If Blahaj isn't installed on your spoke repo, the M3 `lane-env.yml`
workflow will be gated on `vars.BLAHAJ_LANE_ENV_ENABLED == 'true'`
and stay a no-op until you install. That's fine for the lead pilot
playbook; don't block on this.

### 0.5 Current CI surface inventory

```bash
ls -1 .github/workflows/ | sort
test -f Justfile && wc -l Justfile
test -f MODULE.bazel && echo "Bazel: yes"
test -f flake.nix && echo "Nix: yes"
```

Make a mental map of what's already there. The schema upgrade is
**additive** for most files — your existing workflows survive
unchanged (modulo `ci.yml` if you do full M3, which most spokes
won't until ci-templates ships dynamic runner support).

---

## 1. Branching strategy

```bash
git fetch origin main
git checkout -b feat/ci-schema-v1-m1 origin/main
```

**Important**: branch off **origin/main**, not your current branch.
The schema work should be isolated from any feature WIP. Two reasons:

1. PR review is cleaner.
2. If you keep your active feature branch checked out while the agent
   works on the schema branch, you'll race-condition on file changes
   (darkmap experienced this 3-4 times during cutover; recovered via
   small-frequent-commit discipline).

**Operator tip**: don't switch branches yourself during the schema
cutover. If you do, the agent's working-tree edits will follow you and
get committed to the wrong branch. The recovery is annoying but the
files survive (untracked stay; tracked-modifications carry; only
`git checkout -- .`-style resets are destructive).

---

## 2. M1 — Schema files + helper scripts

**Time**: ~10 minutes.

Vendor from `tinyland-inc/site.scaffold@feat/ci-schema-d1` (commit
`e53f2c2` at darkmap's adoption):

```bash
SCAFFOLD=~/git/site.scaffold
mkdir -p docs/schemas
cp $SCAFFOLD/docs/CI-SCHEMA.md docs/CI-SCHEMA.md
cp $SCAFFOLD/docs/schemas/lanes.schema.json docs/schemas/
cp $SCAFFOLD/docs/schemas/blahaj-dispatch.schema.json docs/schemas/
cp $SCAFFOLD/.github/lanes.example.json .github/lanes.example.json
cp $SCAFFOLD/scripts/validate-lanes.py scripts/
cp $SCAFFOLD/scripts/lane-dispatch.py scripts/
cp $SCAFFOLD/scripts/check-conformance.sh scripts/
chmod +x scripts/validate-lanes.py scripts/lane-dispatch.py scripts/check-conformance.sh
```

Write your **spoke-specific** `.github/lanes.json` (single-lane
default; copy from the three-lane example if multi-trunk):

```json
{
  "$schema": "../docs/schemas/lanes.schema.json",
  "schema_version": 1,
  "spoke": { "name": "<your-spoke>", "domain": "<your-domain>" },
  "defaults": {
    "runner_class": "tinyland-nix",
    "ttl_hours": 72,
    "flywheel_target_classes": ["sveltekit-app-build", "sveltekit-unit-tests"]
  },
  "lanes": [
    {
      "name": "default",
      "trigger": "pull_request",
      "theme": "<your-spoke>",
      "snapshot_source": "checked-in",
      "e2e": false
    }
  ]
}
```

Add to `.gitignore` (adapt the path if your tofu lives outside
`infra/tofu/`):

```
infra/tofu/.terraform/
infra/tofu/.terraform.lock.hcl
**/*.tfstate
**/*.tfstate.backup
```

**Commit + push immediately.** Don't batch with M2.

### Verification

```bash
python3 -c "import json; json.load(open('.github/lanes.json'))"
bash scripts/check-conformance.sh   # 6/0/6 expected at this point
```

---

## 3. M2 — devshell + .bazelrc.flywheel + Justfile recipes

**Time**: ~15-20 minutes.

### flake.nix

Add to `buildInputs`:

- `python3`, `python3Packages.jsonschema` — for `just lanes-validate`.
- `jq` — for `lane-dispatch.py` + the conformance script.
- `netcat-gnu` — for the `FLYWHEEL=auto` cluster reachability probe.
- `terraform-ls`, `tflint` — LSP/lint for the Tofu work in M4.

Existing `opentofu` is preserved (darkmap already had it). Add echo
lines for `python` and `jq` in the `shellHook` for visibility.

### .bazelrc split

Move the inline `common:flywheel` block out into `.bazelrc.flywheel`
(vendored from `$SCAFFOLD/.bazelrc.flywheel`). Replace the inline
block in `.bazelrc` with:

```
try-import %workspace%/.bazelrc.flywheel
```

This adds `--config=flywheel` (cache-only, same as your previous
inline block) AND `--config=flywheel-executor` (proved-class executor;
new). If your repo already has bespoke `--config=ci-cached` /
`--config=executor-backed` profiles (like darkmap does), **keep them
unchanged** — both flows coexist.

### Justfile recipes (9 new)

Don't overlap with existing tofu / bazel / kustomize recipes. Add the
section verbatim from `$SCAFFOLD/Justfile`:

- `lanes-list`, `lanes-validate`, `lane-dispatch`, `lane-reap`,
  `conformance`
- `flywheel-build`, `flywheel-test`
- `dev-remote` (v1.1+ stub)
- `sync-flywheel-bazelrc` (placeholder)
- `_flywheel-flag` helper with `FLYWHEEL=local|cache|executor|auto`

### Verification

```bash
just --list | grep -E '(lanes-|lane-|conformance|flywheel-)'   # 9 recipes
nix develop --command just lanes-validate                       # 0 errors
nix develop --command bash scripts/check-conformance.sh         # 8/0/4 now
```

---

## 4. M3 — workflow cutover (PARTIAL for most spokes)

**Time**: ~20 minutes for the lane-env.yml piece (the part everyone
does); deferred indefinitely for the ci.yml replacement (see friction).

### lane-env.yml (DO THIS)

Net-new file, no conflict. Wrap
`tinyland-inc/ci-templates/.github/workflows/spoke-lane-env.yml@v2`.
Use the darkmap version as reference; substitute `spoke:` and the
image repository.

**Critical**: gate the job on
`if: ${{ vars.BLAHAJ_LANE_ENV_ENABLED == 'true' }}` so the workflow
no-ops cleanly until you actually install Blahaj on the repo and set
the dispatch secret. ci-templates v2 also makes
`BLAHAJ_DISPATCH_TOKEN` optional inside the reusable workflow, so
pull-request triggers are safe before Blahaj is installed.

### ci.yml replacement (PROBABLY SKIP)

The plan said "replace ci.yml with a thin wrapper over
spoke-ci.yml@v1.0.0". **For darkmap this was not viable** because the
existing ci.yml has machinery `spoke-ci.yml@v1.0.0` doesn't support:

1. **Dynamic runner-class fallback** via
   `runs-on: ${{ fromJSON(vars.PRIMARY_LINUX_RUNNER_LABELS_JSON || '["ubuntu-latest"]') }}`.
2. **`GF_BAZEL_CONFIG` auto-detect** based on which cluster labels
   actually resolve at the moment of the workflow run.
3. **`tinyland-inc/GloriousFlywheel/.github/actions/nix-job@main`**
   composite (uses the per-spoke cache contract; not the same as
   `ci-templates/nix-setup`).

Replacing ci.yml outright loses graceful degradation when the cluster
isn't reachable. **Most spokes will be in the same boat.** The
recommendation:

- Preserve your existing ci.yml unchanged.
- Document the deviation in AGENTS.md (M5).
- Wait for the **ci-templates v1.1** feedback PR (filed as part of
  darkmap's M6) that adds `runner_labels_json` input support to
  `spoke-ci.yml`. Then revisit.

The conformance script's "ci.yml ci-templates pin" check will stay
MANUAL until then. Acceptable.

---

## 5. M4 — Tofu spoke-* composition

**Time**: ~30 minutes.

### What lands

Add the five `spoke-*` module compositions to your Tofu root
(`infra/tofu/main.tf` for darkmap; could be `tofu/main.tf` for a
greenfield spoke). **Append; do NOT replace** existing Cloudflare /
Kubernetes / Kustomize resources.

Source pin:
`git::ssh://git@github.com/tinyland-inc/GloriousFlywheel.git//tofu/modules/spoke-<name>?ref=spoke-tofu-modules-v1.0.0`.
This is a **scoped** tag — not a whole-repo `v1.0.0` of
GloriousFlywheel.

### Count-gating pattern (recommended)

Each module should be gated on a per-feature boolean variable that
defaults to **false**:

```hcl
module "spoke_state_namespace" {
  count  = var.spoke_state_namespace_enabled ? 1 : 0
  source = "${local.spoke_modules_source}/spoke-state-namespace?ref=${local.spoke_modules_ref}"
  spoke_slug = "<your-spoke>"
  # ...
}
```

This lets you ship the M4 PR as a no-op apply, then flip each gate as
operator-side preconditions are met (Blahaj installed, runner-pool
ACL controller deployed, external-dns watching the spoke namespace,
etc.). Significantly reduces blast radius.

### Verification

```bash
cd infra/tofu
rm -rf .terraform .terraform.lock.hcl
nix develop --command tofu init -backend=false -input=false
nix develop --command tofu validate    # Success! The configuration is valid.
```

If `tofu validate` complains about a `variable = "s3:prefix"` line in
your spoke-state-namespace module, that's the
`validate-tofu-image-pins.py` false positive — **fixed in the
spoke-tofu-modules PR**, should be a non-issue. If you see it,
something pinned an older Flywheel ref.

---

## 6. M5 — AGENTS.md + conformance to (acceptable) green

**Time**: ~10 minutes for the doc; conformance MANUALs may persist.

Append the 5 sections to AGENTS.md verbatim from
`$SCAFFOLD/AGENTS.md`, adapted for your spoke:

- **Multi-Lane Posture** — name your lane count + cite scaffold tag.
- **Flywheel Binding** — both configs explained; hard NOs.
- **Per-PR Ephemeral Envs** — DNS pattern; document Blahaj
  installation status.
- **Tofu Posture** — preserved resources; spoke-* modules consumed;
  state backend (with the rustfs-as-S3-API clarification if
  applicable).
- **Conformance** — Path A vs Path B for the ruleset (see §7 below).

### Org-ruleset Path A vs Path B (Jesssullivan-owned spokes)

If your spoke is in `Jesssullivan/*` or another non-tinyland-inc org,
the `tinyland-spoke-default` ruleset doesn't auto-apply.

- **Path A** (lower friction): Document the gap in AGENTS.md.
  Branch protection is configured manually in `Settings → Rules`.
  Conformance reports as MANUAL. Acceptable for lead pilots and
  most spokes.
- **Path B** (stricter): `gh api /repos/<owner>/<spoke>/rulesets -X POST --input <ruleset.json>`.
  One-time; updates require re-application. Use when the spoke is
  business-critical or has external contributors.

darkmap used Path A.

---

## 7. M6 — validation + feedback loop

**Time**: ~30 minutes for validation + feedback PRs.

### Validation

Open a tiny no-op PR (one-file marker is fine) to fire `lane-env.yml`
and check the gate behavior. On darkmap PR #82 this surfaced a v1 bug:
`spoke-lane-env.yml@v1.0.0` required `BLAHAJ_DISPATCH_TOKEN`, and
GitHub resolved that required secret at workflow-call parse time before
the caller's job-level `if:` could skip. The temporary workaround was
to comment out the `pull_request:` trigger.

ci-templates v2 is the fix: `BLAHAJ_DISPATCH_TOKEN` is optional and
the reusable workflow exits cleanly when the token is empty. Spokes can
keep the `pull_request:` trigger enabled while still gating actual
dispatch with `vars.BLAHAJ_LANE_ENV_ENABLED == 'true'`.

### Feedback PRs

Anything that surprised you during the cutover → PR back to
`ci-templates` or `site.scaffold`. Darkmap's cutover surfaced five:

1. **ci-templates v2** — `spoke-lane-env.yml` makes
   `BLAHAJ_DISPATCH_TOKEN: required: false` so spokes can safely
   no-op-gate the `pull_request:` trigger before Blahaj is installed.
   GitHub resolves required secrets at parse time, BEFORE job-level
   `if:` gates evaluate, so v1 callers must not be used for unwired
   spokes.
2. **ci-templates v1.1** — `spoke-ci.yml` needs `runner_labels_json`
   input for spokes with dynamic runner-class fallback. (PR filed.)
3. **ci-templates v1.0.1** — `release.yml`'s empty-commit pattern
   conflicts with local push-protection hooks + GitHub rebase-merge
   dropping empty commits. Documented manual fallback in RELEASING.md.
   (PR filed.)
4. **GloriousFlywheel** — `validate-tofu-image-pins.py` had a false
   positive on AWS IAM `variable = "s3:prefix"`. (Fixed in PR #710.)
5. **GloriousFlywheel** — `Check External Links` 404s on private
   `tinyland-inc/*` URLs (lychee can't auth). Stripped private URLs
   to bare text. Permanent fix awaits site.scaffold public projection.

---

## 8. Pitfalls (from actual darkmap experience)

| Pitfall | Symptom | Fix |
|---|---|---|
| **Working tree carries across branch switches** | Your edits show as "modified" on a branch you didn't intend to commit to | Always `git status --short` before staging; stage by specific path, never `git add .` |
| **GPG agent times out mid-session** | `gpg: signing failed: Timeout` after the cache window expires (~5 min idle) | Unlock with `echo test \| gpg --clearsign >/dev/null` from a fresh shell |
| **Private-repo URLs 404 in link checkers** | External link CI job fails on `https://github.com/tinyland-inc/<repo>/...` | Strip to bare text references until the repo is public, OR use raw.githubusercontent.com URLs (which auth-handle differently) |
| **`tofu init` requires the upstream tag to exist** | `tofu validate` fails with module-not-found errors | Cut the upstream tag FIRST; the scaffold's `just tofu-validate` recipe graceful-degrades with a friendly message but real validation needs the tag |
| **`release.yml` rebase-merge drops empty commits** | Auto-tag never fires after merging a `release: vX.Y.Z` PR | Cut the tag manually: `git tag -a vX.Y.Z <SHA> -m "..."` |
| **rustfs-as-Tofu-state alarms conformance** | Conformance script reports rustfs reference | False positive if you're using rustfs's S3 API for Tofu state; that's allowed. The §5 invariant only forbids rustfs as RBE CAS / action-cache |

---

## 9. Effort estimate (darkmap actuals)

| Milestone | Estimated | Darkmap actual |
|---|---|---|
| Pre-flight | 10 min | 15 min (org ruleset clarification took thought) |
| M1 schema files | 10 min | 15 min (parallel-branch race forced re-do) |
| M2 devshell + bazelrc + Justfile | 20 min | 25 min |
| M3 lane-env.yml only | 20 min | 20 min |
| M3 ci.yml replacement | 30 min | **DEFERRED** (incompatible) |
| M4 Tofu composition | 30 min | 45 min (validator false positives + private-URL link checks) |
| M5 AGENTS.md + conformance | 10 min | 15 min |
| M6 validation + playbook + feedback PRs | 30 min | ~60 min |
| **Total** | ~2h 10min | **~3h 15min** for partial M3 |

Most overruns came from:
1. **Parallel branch switching during cutover** (~30 min recovery
   over 2 races). Avoid: don't work in the spoke while the agent is
   doing the cutover.
2. **GPG agent re-unlock cycles** (~15 min cumulative).
3. **Upstream CI validators catching legitimate issues** (~30 min,
   value-positive — the fixes shipped).

---

## 10. Next spoke (recommended order)

After darkmap (lead pilot), the planning session ranked:

1. **omux ancestral spoke** — site.scaffold was extracted from omux.
   90% schema-compliant already. Cleanest fit.
2. **darkmap.phasi.space** — done (this playbook).
3. **MassageIthaca** — defer until payment-mode (TIN-992) and Modal
   decom (TIN-981) settle. Will be the multi-lane stress test.
4. **jesssullivan.github.io** — defer further. Not a spoke shape;
   blog automation + Nix adoption are prerequisites.
5. **tinyland.dev** — NOT a spoke; it's the authority. Composite-only
   adoption track (separate `AUTHORITY-CI-SCHEMA.md` follow-on).

---

## 11. Authority

- **Schema**: `tinyland-inc/site.scaffold/docs/CI-SCHEMA.md`
  ([PR #10](https://github.com/tinyland-inc/site.scaffold/pull/10))
- **Reusable workflows**: `tinyland-inc/ci-templates@v2`
  ([release](https://github.com/tinyland-inc/ci-templates/releases/tag/v2.0.0))
- **Tofu modules**: `tinyland-inc/GloriousFlywheel@spoke-tofu-modules-v1.0.0`
  ([release](https://github.com/tinyland-inc/GloriousFlywheel/releases/tag/spoke-tofu-modules-v1.0.0))
- **Org ruleset**: `tinyland-inc/.github/.github/rulesets/tinyland-spoke-default.json`
- **Lead pilot PR**: [darkmap #77](https://github.com/Jesssullivan/darkmap.phasi.space/pull/77)
- **Linear parent**: [TIN-1381](https://linear.app/tinyland/issue/TIN-1381)
