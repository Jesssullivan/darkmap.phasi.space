process.env.DARKMAP_RBE_SMOKE_SCENARIO = 'aq-dashboard';
// Desktop so the dashboard cards lay out; the assertions are DOM/behavioural
// (the OpenAQ fetch fires + the AQI badge computes + the area station count is
// non-zero), so they are font- and viewport-independent.
process.env.DARKMAP_RBE_SMOKE_VIEWPORTS = process.env.DARKMAP_RBE_SMOKE_VIEWPORTS ?? '1280x800';

await import('./run-playwright-local-route-smoke.mjs');
