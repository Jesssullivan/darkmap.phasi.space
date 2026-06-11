import { expect, test } from '@playwright/test';

/**
 * H1 — the TimeHelix (the twilight gantt's successor) renders the now-centered
 * helical ribbon at COMPACT. The helix auto-opens post-mount (ephemerisOpen=true)
 * and lives in the dock's `.dock-gantt-row`. This spec measures its box, the
 * phase-colored ribbon segments, and the now-centering acceptance (un-scrubbed
 * mount = cursor at now = the `[data-now-marker]` staff sits in the central third
 * of the scrub bar). Run under webkit-mobile AND chromium-mobile for the engine
 * differential.
 *
 * Run: PLAYWRIGHT_ALL_BROWSERS=1 pnpm exec playwright test --project=webkit-mobile e2e/twilight-compact-webkit.spec.ts
 */

test('H1: time helix renders now-centered with phase-colored ribbon at COMPACT', async ({ page }, testInfo) => {
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(2500); // ephemeris auto-open + the per-day readouts land

	const gantt = page.locator('.dock-gantt-row .gantt').first();
	const present = await gantt.count();
	const box = present ? await gantt.boundingBox().catch(() => null) : null;
	const barBox = await page
		.locator('.dock-gantt-row .gantt .bar')
		.first()
		.boundingBox()
		.catch(() => null);
	const stripes = page.locator('.dock-gantt-row .gantt [data-phase]');
	const stripeCount = await stripes.count().catch(() => 0);
	const distinctPhases = await stripes
		.evaluateAll((els) =>
			Array.from(
				new Set(
					els
						.filter((el) => el.getClientRects().length > 0)
						.map((el) => el.getAttribute('data-phase'))
						.filter((p): p is string => p !== null),
				),
			),
		)
		.catch(() => [] as string[]);
	const markerBox = await page
		.locator('.dock-gantt-row .gantt [data-now-marker]')
		.first()
		.boundingBox()
		.catch(() => null);
	const phaseUnderNow = await page
		.evaluate(() => {
			const marker = document.querySelector('.dock-gantt-row .gantt [data-now-marker]');
			if (!marker) return null;
			const m = marker.getBoundingClientRect();
			const cx = m.left + m.width / 2;
			let best: string | null = null;
			let bestDist = Infinity;
			for (const el of document.querySelectorAll('.dock-gantt-row .gantt .stripe')) {
				const r = el.getBoundingClientRect();
				const dist = Math.abs((r.left + r.right) / 2 - cx);
				if (dist < bestDist) {
					bestDist = dist;
					best = el.getAttribute('data-phase');
				}
			}
			return best;
		})
		.catch(() => null);
	console.log(
		`[H1 ${testInfo.project.name}] helix present=${present} box=${JSON.stringify(box)} bar=${JSON.stringify(barBox)} ` +
			`stripes=${stripeCount} phases=${JSON.stringify(distinctPhases)} nowMarker=${JSON.stringify(markerBox)} ` +
			`phaseUnderNow=${phaseUnderNow}`,
	);
	await page
		.screenshot({
			path: testInfo.outputPath(`twilight-${testInfo.project.name}.png`),
			timeout: 6000,
			animations: 'disabled',
		})
		.catch(() => {});

	// CORRECT behaviour:
	expect(box, 'the time helix is present in the dock row at COMPACT').not.toBeNull();
	expect(box!.height, 'helix is not collapsed (height)').toBeGreaterThan(20);
	expect(box!.width, 'helix has real width').toBeGreaterThan(100);
	expect(stripeCount, 'the ribbon segments actually render').toBeGreaterThan(0);
	expect(
		distinctPhases.length,
		'the ribbon is phase-colored (≥2 distinct data-phase values — not just neutral placeholders)',
	).toBeGreaterThanOrEqual(2);

	// Now-centering acceptance: un-scrubbed mount = cursor at now, so the now
	// staff must sit in the central third of the scrub bar.
	expect(barBox, 'the scrub bar is measurable').not.toBeNull();
	expect(markerBox, 'the now staff ([data-now-marker]) renders').not.toBeNull();
	const markerCx = markerBox!.x + markerBox!.width / 2;
	expect(markerCx, 'now staff right of the central-third left bound').toBeGreaterThan(barBox!.x + barBox!.width / 3);
	expect(markerCx, 'now staff left of the central-third right bound').toBeLessThan(barBox!.x + (2 * barBox!.width) / 3);
});
