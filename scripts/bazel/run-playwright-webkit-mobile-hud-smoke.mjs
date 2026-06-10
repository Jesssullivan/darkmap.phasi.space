// WebKit engine smoke (RBE-native WebKit wiring): the mobile-hud scenario — the
// COMPACT dock contract, the most WebKit-sensitive surface (the dock-grip/detent
// bugs reproduced on WebKit). Same scenario code as the chromium proof; only the
// engine differs.
process.env.DARKMAP_RBE_SMOKE_ENGINE = 'webkit';
process.env.DARKMAP_RBE_SMOKE_SCENARIO = 'mobile-hud';

await import('./run-playwright-local-route-smoke.mjs');
