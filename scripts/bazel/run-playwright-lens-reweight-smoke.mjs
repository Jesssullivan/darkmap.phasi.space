process.env.DARKMAP_RBE_SMOKE_SCENARIO = 'lens-reweight';
// Desktop viewport so the readout has room for all sections; the re-weight
// (section order + tier) is viewport-independent.
process.env.DARKMAP_RBE_SMOKE_VIEWPORTS = process.env.DARKMAP_RBE_SMOKE_VIEWPORTS ?? '1280x800';

await import('./run-playwright-local-route-smoke.mjs');
