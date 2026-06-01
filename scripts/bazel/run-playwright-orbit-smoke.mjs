process.env.DARKMAP_RBE_SMOKE_SCENARIO = 'orbit';
// Desktop so the readout + docked pass planner have room; the panel is
// width-independent.
process.env.DARKMAP_RBE_SMOKE_VIEWPORTS = process.env.DARKMAP_RBE_SMOKE_VIEWPORTS ?? '1280x800';

await import('./run-playwright-local-route-smoke.mjs');
