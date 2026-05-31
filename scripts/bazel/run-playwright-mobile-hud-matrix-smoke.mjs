process.env.DARKMAP_RBE_SMOKE_SCENARIO = 'mobile-hud';
process.env.DARKMAP_RBE_SMOKE_VIEWPORTS = '375x667,390x844,430x932,844x390';

await import('./run-playwright-local-route-smoke.mjs');
