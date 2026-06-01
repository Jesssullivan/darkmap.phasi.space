process.env.DARKMAP_RBE_SMOKE_SCENARIO = 'toolbar-labels';
// Desktop (>820px) must paint the visible tool labels without hover; ≤820px
// collapses them to icon-only while keeping each tool named for AT.
process.env.DARKMAP_RBE_SMOKE_VIEWPORTS = process.env.DARKMAP_RBE_SMOKE_VIEWPORTS ?? '1280x800,390x844';

await import('./run-playwright-local-route-smoke.mjs');
