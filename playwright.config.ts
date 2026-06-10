import { defineConfig, devices } from '@playwright/test';

const port = 3000;
const baseURL = `http://localhost:${port}`;

export default defineConfig({
	testDir: './e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI ? 'github' : 'list',
	timeout: 180_000,
	use: {
		baseURL,
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
		// Firefox + WebKit gated behind PLAYWRIGHT_ALL_BROWSERS to keep M0 fast.
		// Enable in M1 CI by setting PLAYWRIGHT_ALL_BROWSERS=1.
		...(process.env.PLAYWRIGHT_ALL_BROWSERS
			? [
					{
						name: 'firefox',
						use: { ...devices['Desktop Firefox'] },
					},
					{
						name: 'webkit',
						use: { ...devices['Desktop Safari'] },
					},
					// iPhone SE (375×667) WebKit — the engine + the tightest mobile geometry
					// where the dock/twilight/AQ bugs reproduce (iOS Safari/Chrome are both
					// WebKit). hasTouch/isMobile come from the device descriptor, so the
					// *-webkit.spec.ts dock-gesture assertions exercise real touch scrolling.
					{
						name: 'webkit-mobile',
						use: { ...devices['iPhone SE'] },
					},
					// Same iPhone-SE geometry on Chromium — the control for the observe-first
					// webkit-vs-chromium DIFFERENTIAL (a symptom is "a WebKit bug" only if it
					// fails here-passes / there-fails). browserName overrides the device's
					// webkit default while keeping the viewport + touch.
					{
						name: 'chromium-mobile',
						use: { ...devices['iPhone SE'], browserName: 'chromium' as const },
					},
				]
			: []),
	],
	webServer: {
		// Reuse a prebuilt adapter-node bundle when present (CI's e2e lane reuses
		// the artifact from the build job; locally a rerun skips the ~9min build),
		// otherwise build it. Either way serve the Node server on `port`.
		command: '[ -f build/index.js ] || pnpm run build; HOST=127.0.0.1 PORT=' + port + ' node build/index.js',
		port,
		timeout: 300_000,
		reuseExistingServer: !process.env.CI,
	},
});
