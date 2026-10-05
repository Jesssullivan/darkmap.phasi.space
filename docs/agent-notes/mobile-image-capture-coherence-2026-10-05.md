# Mobile image capture coherence — 2026-10-05

Authority: root's screenshot mismatch diagnosis request through release producer;
R-HOOK-CONVERGENCE-20261004, R-N12/R-N13. Prior f155 image receipt asserted Air
pressed but its mobile PNG visibly showed Sky active. Preserve that discrepancy;
it is not accepted as Air capture proof.

Read-only source inspection shows LensSwitcher aria-pressed and active class both
derive from the same active lens prop. LensStore initialization runs synchronously
at page onMount before dynamic MapLibre import. The app lens code was unchanged
by this release's surface CSS fix. No introduced product lens regression is
established; the old driver's viewport resize followed by hash navigation creates
an avoidable route/hydration/camera-hash capture-order race. Its one-time pressed
assertion did not establish stable painted/captured state.

The successor stays on the already mounted desktop document, waits for the real
map diagnostic's first render, resizes, and clicks the actual mobile Air control.
It waits for coherent Air pressed/class/deck/hash state (including the application's
debounced camera hash write), then crosses two animation frames without an
arbitrary sleep. It records deck/hash/storage lens, all mobile chip active/pressed
states and computed colors immediately before and after screenshot; both snapshots
must have Air as the only active/pressed chip. Screenshot bytes receive SHA-256
digests in the same JSON receipt, binding the reviewed PNG to this run.

Node syntax and whitespace checks pass. Producer owns the admitted actual-image
diagnosis; until that run, the exact mismatch cause remains unconfirmed. No app
source, build, heavy browser or cluster mutation occurs in preparing this adapter.
