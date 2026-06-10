import { expect, test } from '@playwright/test';

/**
 * Bug B — the mobile twilight bar (EphemerisGantt) renders wrong at COMPACT.
 * OBSERVE-FIRST: the gantt auto-opens post-mount (ephemerisOpen=true) and lives in
 * the dock's `.dock-gantt-row`. This spec measures its box + the twilight stripes
 * and screenshots — first run = symptom truth (collapsed? stripeless? fine?), then
 * the gate. Run under webkit-mobile AND chromium-mobile for the engine differential.
 *
 * Run: PLAYWRIGHT_ALL_BROWSERS=1 pnpm exec playwright test --project=webkit-mobile e2e/twilight-compact-webkit.spec.ts
 */

test('B1: twilight gantt renders non-collapsed with stripes at COMPACT', async ({ page }, testInfo) => {
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(2500); // ephemeris auto-open + the readout/center data land

	const gantt = page.locator('.dock-gantt-row .gantt').first();
	const present = await gantt.count();
	const box = present ? await gantt.boundingBox().catch(() => null) : null;
	const stripeCount = await page
		.locator('.dock-gantt-row .gantt .bar .stripe')
		.count()
		.catch(() => 0);
	const barBox = await page
		.locator('.dock-gantt-row .gantt .bar')
		.first()
		.boundingBox()
		.catch(() => null);
	console.log(
		`[B1 ${testInfo.project.name}] gantt present=${present} box=${JSON.stringify(box)} bar=${JSON.stringify(barBox)} stripes=${stripeCount}`,
	);
	await page
		.screenshot({
			path: testInfo.outputPath(`twilight-${testInfo.project.name}.png`),
			timeout: 6000,
			animations: 'disabled',
		})
		.catch(() => {});

	// CORRECT behaviour (red = the reported "not displaying properly"):
	expect(box, 'the twilight gantt is present in the dock row at COMPACT').not.toBeNull();
	expect(box!.height, 'gantt is not collapsed (height)').toBeGreaterThan(20);
	expect(box!.width, 'gantt has real width').toBeGreaterThan(100);
	expect(stripeCount, 'the twilight bands (stripes) actually render').toBeGreaterThan(0);
});
