import { expect, test } from '@playwright/test';

/**
 * Bug A — the COMPACT bottom-sheet (ResponsiveDock) won't change detents on
 * WebKit. OBSERVE-FIRST: measure the real geometry + scroll behaviour and log it;
 * the assertions encode the CORRECT behaviour, so a webkit-mobile run that goes RED
 * is the reproduction. Run the SAME file under --project=chromium-mobile for the
 * engine differential.
 *
 * Run: PLAYWRIGHT_ALL_BROWSERS=1 pnpm exec playwright test --project=webkit-mobile e2e/dock-webkit.spec.ts
 *
 * The dock mounts at COMPACT-tall (dockActive); the iPhone-SE project gives 375×667
 * + touch. We pin a point with page.mouse.click (NOT locator.click, which hangs on
 * the continuously-animating MapLibre canvas) to raise the sheet to HALF.
 */

async function pinPoint(page: import('@playwright/test').Page): Promise<void> {
	await page.goto('/');
	await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 30_000 });
	await page.waitForTimeout(2000); // map first paint + handlers attach
	// Click a point in the upper map strip (the dock rail is pointer-events:none, so a
	// click there reaches the map). mouse.click does NO actionability/stability wait.
	await page.mouse.click(187, 230);
	await page.waitForTimeout(1500); // auto-raise to HALF + readout lands
}

const RAIL_METRICS = () => {
	const rail = document.querySelector('.dock-rail') as HTMLElement | null;
	const half = document.querySelector('.dock-snap-half') as HTMLElement | null;
	const peek = document.querySelector('.dock-snap-peek') as HTMLElement | null;
	const sheet = document.querySelector('.dock-sheet') as HTMLElement | null;
	const body = document.querySelector('.dock-body') as HTMLElement | null;
	if (!rail) return null;
	const cs = getComputedStyle(rail);
	return {
		railDisplay: cs.display,
		railOverflowY: cs.overflowY,
		scrollTop: Math.round(rail.scrollTop),
		scrollHeight: Math.round(rail.scrollHeight),
		clientHeight: Math.round(rail.clientHeight),
		maxTop: Math.round(rail.scrollHeight - rail.clientHeight),
		peekOffsetTop: peek ? Math.round(peek.offsetTop) : null,
		halfOffsetTop: half ? Math.round(half.offsetTop) : null,
		sheetDisplay: sheet ? getComputedStyle(sheet).display : null,
		bodyOverflowY: body ? getComputedStyle(body).overflowY : null,
	};
};

test.describe('Bug A — dock detents on WebKit (observe-first)', () => {
	test('A3: rail geometry — display + three distinct, monotonic detents', async ({ page }, testInfo) => {
		await pinPoint(page);
		const m = await page.evaluate(RAIL_METRICS);
		console.log(`[A3 ${testInfo.project.name}] rail metrics:`, JSON.stringify(m));
		expect(m, 'dock-rail must exist (dock is COMPACT-active at iPhone SE)').not.toBeNull();
		const g = m!;
		// The three detents PEEK(0) / HALF(halfOffsetTop) / FULL(maxTop) must be distinct +
		// monotonically increasing, else the sheet can't rest at three places.
		expect(g.halfOffsetTop, 'HALF detent offset present + above PEEK').toBeGreaterThan(0);
		expect(g.maxTop, 'FULL (maxTop) above HALF — three distinct rests').toBeGreaterThan(g.halfOffsetTop ?? 0);
		expect(g.scrollHeight, 'rail content overflows the viewport (so it is scrollable)').toBeGreaterThan(g.clientHeight);
	});

	test('A2: the rail scrolls + the body swallows a drag (programmatic + wheel probes)', async ({ page }, testInfo) => {
		await pinPoint(page);
		const before = await page.evaluate(RAIL_METRICS);
		console.log(`[A2 ${testInfo.project.name}] before:`, JSON.stringify(before));
		expect(before, 'rail present').not.toBeNull();

		// (1) PROGRAMMATIC scroll — can the rail be moved to FULL at all on this engine?
		// (the resettle fix relies on this same `rail.scrollTop = …` primitive.)
		const afterProgrammatic = await page.evaluate(() => {
			const rail = document.querySelector('.dock-rail') as HTMLElement | null;
			if (!rail) return null;
			rail.scrollTop = rail.scrollHeight - rail.clientHeight; // → FULL
			return Math.round(rail.scrollTop);
		});
		console.log(`[A2 ${testInfo.project.name}] scrollTop after programmatic →FULL write:`, afterProgrammatic);

		// (2) WHEEL over the BODY — does a body-scroll get swallowed (overflow-y:auto) so the
		// rail/detent never moves?
		await page.evaluate(() => {
			const r = document.querySelector('.dock-rail') as HTMLElement | null;
			if (r) r.scrollTop = 0;
		});
		await page.waitForTimeout(200);
		const bodyBox = await page
			.locator('.dock-body')
			.boundingBox()
			.catch(() => null);
		let railAfterBodyWheel: number | null | 'wheel-unsupported' = null;
		if (bodyBox) {
			// NOTE: page.mouse.wheel is unreliable on WebKit (throws) — guard so the probe
			// is observational on chromium and a no-op on webkit (the real touch-drag is
			// device-only / the harness's job).
			try {
				await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2);
				await page.mouse.wheel(0, 400);
				await page.waitForTimeout(400);
				railAfterBodyWheel = await page.evaluate(() => {
					const r = document.querySelector('.dock-rail') as HTMLElement | null;
					return r ? Math.round(r.scrollTop) : null;
				});
			} catch {
				railAfterBodyWheel = 'wheel-unsupported';
			}
		}
		console.log(
			`[A2 ${testInfo.project.name}] rail scrollTop after a wheel over .dock-body:`,
			railAfterBodyWheel,
			'(≈0 ⇒ body swallowed it)',
		);
		await page
			.screenshot({
				path: testInfo.outputPath(`dock-${testInfo.project.name}.png`),
				timeout: 6000,
				animations: 'disabled',
			})
			.catch(() => {});

		// CORRECT behaviour: a programmatic write to FULL must move scrollTop near maxTop.
		// Red here = the re-pin primitive is ignored on this engine (the crux of cause #1).
		expect(afterProgrammatic, 'programmatic scrollTop→FULL returns a number').not.toBeNull();
		expect(afterProgrammatic!, 'rail.scrollTop write must land near FULL').toBeGreaterThan((before!.maxTop ?? 0) * 0.5);
	});
});
