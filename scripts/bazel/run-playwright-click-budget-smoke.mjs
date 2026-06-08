process.env.DARKMAP_RBE_SMOKE_SCENARIO = 'click-budget';
// Desktop (WIDE) so all five Command Deck regions are present and the readout's
// deep-tool CTAs (transmission / pass) are reachable — the reachable-in-N budget
// is proven against the full grid, not a COMPACT fallback.
process.env.DARKMAP_RBE_SMOKE_VIEWPORTS = process.env.DARKMAP_RBE_SMOKE_VIEWPORTS ?? '1280x800';

await import('./run-playwright-local-route-smoke.mjs');
