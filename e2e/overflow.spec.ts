import { expect, test, type Page } from '@playwright/test';

// Static scaffold regression guard: no document-level horizontal overflow at
// canonical breakpoints, and every same-page hash link on the home route
// resolves to an actual element.

const breakpoints = [
	{ label: 'mobile-small', width: 390, height: 844 },
	{ label: 'mobile-large', width: 430, height: 932 },
	{ label: 'tablet', width: 768, height: 1024 },
	{ label: 'desktop', width: 1440, height: 1200 },
];

for (const bp of breakpoints) {
	test(`home page has no document overflow at ${bp.label} (${bp.width}px)`, async ({ page }) => {
		await page.setViewportSize({ width: bp.width, height: bp.height });
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		const { scrollWidth, innerWidth } = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			innerWidth: window.innerWidth,
		}));
		// Tolerate up to 1px subpixel rounding; anything beyond means real overflow.
		expect(scrollWidth, `${bp.label} document overflow`).toBeLessThanOrEqual(innerWidth + 1);
	});
}

test('home-route same-page hash links all resolve to an element', async ({ page }) => {
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	const broken = await page.evaluate(() => {
		const hashes = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
			.map((a) => a.getAttribute('href') ?? '')
			.filter((h) => h.startsWith('/#') || h.startsWith('#'))
			.map((h) => (h.startsWith('/#') ? h.slice(1) : h));
		const unique = Array.from(new Set(hashes));
		return unique.filter((h) => h.length > 1 && !document.querySelector(h));
	});
	expect(broken, 'home-route hash targets without matching element').toEqual([]);
});

type Box = {
	readonly x: number;
	readonly y: number;
	readonly right: number;
	readonly bottom: number;
	readonly display: string;
} | null;

const boxSelectors = {
	gantt: '.gantt',
	toolbar: '.toolbar',
	geocoder: '.geocoder',
	railToggle: '.rail-toggle',
	sky: '.sky',
	attribution: '.attribution',
	pointReadout: '.readout[role=dialog]',
} as const;

const hasOverlap = (a: Box, b: Box): boolean =>
	!!(
		a &&
		b &&
		a.display !== 'none' &&
		b.display !== 'none' &&
		a.x < b.right &&
		a.right > b.x &&
		a.y < b.bottom &&
		a.bottom > b.y
	);

async function overlayState(page: Page) {
	return page.evaluate((selectors) => {
		const rect = (selector: string) => {
			const el = document.querySelector(selector);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			const style = getComputedStyle(el);
			return {
				x: Math.round(r.x),
				y: Math.round(r.y),
				right: Math.round(r.right),
				bottom: Math.round(r.bottom),
				display: style.display,
			};
		};
		return Object.fromEntries(Object.entries(selectors).map(([key, selector]) => [key, rect(selector)]));
	}, boxSelectors) as Promise<Record<keyof typeof boxSelectors, Box>>;
}

for (const bp of breakpoints.filter((bp) => bp.width <= 768)) {
	test(`field overlays do not collide at ${bp.label} (${bp.width}px)`, async ({ page }) => {
		await page.setViewportSize({ width: bp.width, height: bp.height });
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		await page.waitForSelector('.gantt');

		const before = await overlayState(page);
		expect(hasOverlap(before.gantt, before.toolbar), `${bp.label} gantt/toolbar overlap`).toBe(false);
		expect(hasOverlap(before.gantt, before.attribution), `${bp.label} gantt/attribution overlap`).toBe(false);
		expect(hasOverlap(before.geocoder, before.railToggle), `${bp.label} geocoder/layer toggle overlap`).toBe(false);
		expect(hasOverlap(before.sky, before.geocoder), `${bp.label} sky/geocoder overlap`).toBe(false);

		await page.mouse.click(Math.floor(bp.width / 2), Math.floor(bp.height / 2));
		await page.waitForSelector('.readout[role=dialog]');

		const afterTap = await overlayState(page);
		expect(hasOverlap(afterTap.pointReadout, afterTap.gantt), `${bp.label} readout/gantt overlap`).toBe(false);
		expect(hasOverlap(afterTap.pointReadout, afterTap.toolbar), `${bp.label} readout/toolbar overlap`).toBe(false);
	});
}

test('twilight rail supports pointer scrubbing', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	// The first-visit tour card overlays the dock rail at this viewport (the
	// helix strip is taller than the old gantt bar, so the rail's center line
	// sits under the card); seed the tour-seen flag so the drag reaches the
	// slider (the aq-dashboard spec's idiom — clicking Skip races tour mount).
	await page.addInitScript(() => localStorage.setItem('darkmap-tour-v1', '1'));
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	const bar = page.locator('.gantt .bar');
	await expect(bar).toBeVisible();
	const before = await bar.getAttribute('aria-valuenow');
	const box = await bar.boundingBox();
	expect(box).not.toBeNull();
	if (!box) return;
	await page.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2, { steps: 5 });
	await page.mouse.up();
	await expect(bar).not.toHaveAttribute('aria-valuenow', before ?? '');
});
