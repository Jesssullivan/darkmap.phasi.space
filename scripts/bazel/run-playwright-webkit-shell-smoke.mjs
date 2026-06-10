// WebKit engine smoke (RBE-native WebKit wiring): the shell scenario on the engine
// iOS Safari AND iOS Chrome actually run. Locally resolves Playwright's managed
// webkit binary (`pnpm exec playwright install webkit`); on a future GF webkit cell
// set GF_RBE_WEBKIT_EXECUTABLE (the cell needs `playwright install-deps webkit` +
// REAL FONTS — WebKit has no fontless/swiftshader mode).
process.env.DARKMAP_RBE_SMOKE_ENGINE = 'webkit';
process.env.DARKMAP_RBE_SMOKE_SCENARIO = 'shell';

await import('./run-playwright-local-route-smoke.mjs');
