process.env.DARKMAP_RBE_SMOKE_SCENARIO = 'smog';
// Desktop so the lens switcher + LayerRail have room; the assertion is
// behavioural (the OpenAQ station fetch fires on the Air-lens switch), not
// pixel-based, so it is viewport- and font-independent.
process.env.DARKMAP_RBE_SMOKE_VIEWPORTS = process.env.DARKMAP_RBE_SMOKE_VIEWPORTS ?? '1280x800';

await import('./run-playwright-local-route-smoke.mjs');
