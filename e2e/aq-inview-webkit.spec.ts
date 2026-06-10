import { expect, test } from '@playwright/test';

/**
 * Bug C — the AQ "in view" viewport instrument on mobile. OBSERVE-FIRST + DIFFERENTIAL.
 *
 * What the first runs SETTLED (logged here, kept as a regression guard):
 *  - `.instrument-column` exists in the DOM (count=1) but is NOT visible at COMPACT
 *    (it lives in `.left-dock`, which is display:contents-inert ≤1023px) — i.e. the AQ
 *    in-view instrument has no mobile home. THAT is "AQ in view not working" on mobile.
 *  - The tile's value/sub are IDENTICAL on webkit-mobile and chromium-mobile
 *    ("—" / "no stations in view" with a keyless local server) — no engine differential
 *    ⇒ NOT a WebKit data bug, it's the known missing-OPENAQ-key artifact (prod works).
 *
 * Minimal + interaction-free (no click/pan/screenshot — those hang on the live map):
 * goto + the eager fetch (onMount/lens-change → 500ms debounce) + read.
 *
 * Run: PLAYWRIGHT_ALL_BROWSERS=1 pnpm exec playwright test --project=webkit-mobile e2e/aq-inview-webkit.spec.ts
 *   (and --project=chromium-mobile for the control)
 */

test('C1: Air-lens in-view instrument — coherent state + the COMPACT visibility observation', async ({
	page,
}, testInfo) => {
	await page.goto('/#m=34.05,-118.24,9&lens=air');
	await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 30_000 });
	await page.waitForTimeout(4000); // map first paint + the eager viewport-AQ fetch settles

	const col = page.locator('.instrument-column').first();
	const colCount = await page.locator('.instrument-column').count();
	const colVisible = colCount ? await col.isVisible().catch(() => false) : false;
	const aqiValue = await col
		.locator('.aqi-value')
		.first()
		.textContent()
		.catch(() => null);
	const aqiSub = await col
		.locator('.aqi-sub')
		.first()
		.textContent()
		.catch(() => null);
	console.log(
		`[C1 ${testInfo.project.name}] instrument count=${colCount} visibleAtCOMPACT=${colVisible} aqi-value=${JSON.stringify(aqiValue)} aqi-sub=${JSON.stringify(aqiSub)}`,
	);

	// Honesty-bar invariant (both engines, keyed or not): a real AQI number OR an explicit
	// empty-state — never blank, never a fabricated 0. (The COMPACT visibility is LOGGED
	// here; the fix PR turns it into the gate: instrument must be reachable on mobile.)
	expect(aqiValue, 'instrument tile renders a value or an honest dash').toBeTruthy();
	if (aqiValue && aqiValue.trim() !== '—') {
		expect(aqiValue.trim(), 'a populated AQI is a real number, never a fabricated 0').not.toBe('0');
	} else {
		expect(aqiSub ?? '', 'the empty-state names why (no stations / no PM2.5)').toMatch(/no (stations|pm2\.5)/i);
	}
});
