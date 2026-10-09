# Remove retired Pages marker from production precache

Authority: root narrow-source approval after actual published dd28 image failed
worker installation. Parent dd28a8398699e6b790ab29616ad07a15d52c1a02 and both
failed image receipts remain preserved. Reliability/cache lane.

Actual diagnostic: secure context true, both automatic Kit and explicit app
registration promises resolved, original worker created, controller absent and
registrations subsequently empty. Local same-origin fixture proxy recorded
exactly one non-successful upstream asset: /.nojekyll HTTP404; subsequent
app-shell requests aborted. Source service-worker.ts uses cache.addAll over
Kit build/files/prerendered assets; that operation rejects installation when
any listed response is unsuccessful. No synthetic worker or manual registration
was introduced. This evidence identifies an installation blocker, not proof
that every later runtime cache check will pass.

The current source has no Pages deployment workflow, deploy-pages or
upload-pages action; svelte.config.js uses adapter-node and Container builds
the production Node image. .nojekyll is the retired GitHub Pages/Jekyll bypass
marker; no current source/workflow references it. Remove ONLY static/.nojekyll
so it is no longer emitted in Kit's static-files precache list. Retain static/CNAME
unchanged; no host/DNS retirement or unrelated cleanup. Do not weaken addAll,
skip broken assets globally or register manually to fabricate acceptance.

Focused source checks: marker absent; no Pages workflow/marker references in
active workflows; adapter-node remains selected; CNAME unchanged; service-worker
and runtime-cache source/test bytes unchanged from dd28; git diff --check PASS.
Prior exact local Bazel runtime-cache 31/31 tests retain relevance because no
runtime code changed, but are not a new candidate build/image/browser receipt.
Next root-reviewed publication must bind new source SHA to actual immutable
index/amd64 child and re-run real compiled worker registration then FULL cache
mode, using a new absent artifact path. Publication/browser not performed here.
