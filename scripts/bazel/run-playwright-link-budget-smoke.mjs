process.env.DARKMAP_RBE_SMOKE_SCENARIO = 'link-budget';
// Desktop so the transmission sheet + link-budget panel have room; the panel
// itself is width-independent.
process.env.DARKMAP_RBE_SMOKE_VIEWPORTS = process.env.DARKMAP_RBE_SMOKE_VIEWPORTS ?? '1280x800';

await import('./run-playwright-local-route-smoke.mjs');
