process.env.DARKMAP_RBE_SMOKE_SCENARIO = 'lens';
// Prove both the labelled desktop chips (>820px) and the ≤820px compact
// icon-only row, which must stay reachable by accessible name.
process.env.DARKMAP_RBE_SMOKE_VIEWPORTS = process.env.DARKMAP_RBE_SMOKE_VIEWPORTS ?? '1280x800,390x844';

await import('./run-playwright-local-route-smoke.mjs');
