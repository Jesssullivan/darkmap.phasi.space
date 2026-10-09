# Published-image visual gate successor — 2026-10-05

Authority: root's actual screenshot review via release producer;
R-HOOK-CONVERGENCE-20261004, R-N12/R-N13. Preserve prior c2fd image-smoke receipts:
published image 8485126b was behaviorally passing but visually rejected for pale
detached surface / near-white title. No cluster rollout is accepted from that run.

The separate operator adapter now records actual computed title foreground and
ancestor background colors, composites sRGB transparency over white, and fails
below 4.5:1 contrast. A detached screenshot is preserved before that assertion.
This is a bounded text/surface gate, not comprehensive accessibility certification
or a substitute for reviewing the actual screenshots.

Mobile evidence now clicks the responsive dock's actual Air button and asserts
aria-pressed=true before capture; the URL fragment alone is not evidence that the
Air lens was selected. Three light contrast fixtures pass (pale rejection, dark
translucent acceptance, exact black/white 21:1), alongside node syntax and
whitespace checks. No application source, image build, heavy browser or cluster
mutation occurs in preparing this successor. Producer reruns it against the
replacement image, recording both exact application and adapter SHAs/digests.
