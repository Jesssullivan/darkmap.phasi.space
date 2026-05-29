import { expect, test, type Page } from '@playwright/test';

/**
 * Guards the HelpTooltip popover-clipping fix (design-review finding).
 *
 * The model-card `?` popovers live inside the LayerRail, which scrolls
 * (`overflow-y: auto`). Skeleton 4.15.2 renders the Popover positioner
 * inline, so the popover was clipped at the rail's edge — the help text
 * got cut off. The fix portals the positioner to <body>. These tests
 * assert the popover (a) escapes the rail and (b) sits fully within the
 * viewport, at desktop and iPhone-14.
 */

const openRail = async (page: Page): Promise<void> => {
	const toggle = page.getByRole('button', { name: /Open layers/i });
	if (await toggle.isVisible().catch(() => false)) await toggle.click();
};

/** Open the VIIRS model-card help and return its bounding box. */
const openViirsModelCard = async (page: Page) => {
	await openRail(page);
	// The VIIRS row's "?" help trigger (aria-label "Show help").
	const help = page.getByRole('button', { name: /Show help/i }).first();
	await expect(help).toBeVisible();
	await help.click();
	// Scope to the VIIRS card by its title — multiple model cards exist in the
	// (portaled) DOM, so a bare `.model-card` selector is ambiguous.
	const card = page.locator('.model-card').filter({ hasText: 'VIIRS night lights' });
	await expect(card).toBeVisible();
	return card;
};

test.describe('HelpTooltip popover portaling (design-review)', () => {
	test('desktop: model-card popover is portaled out of the rail and within the viewport', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/');
		await page.waitForLoadState('domcontentloaded');

		const card = await openViirsModelCard(page);

		// Portaled: the popover is NOT a descendant of the layer rail.
		const insideRail = await card.evaluate((el) => el.closest('.layer-rail') !== null);
		expect(insideRail).toBe(false);

		// Not clipped: the popover's right + left edges sit within the viewport.
		const box = await card.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
		// Sanity: the card actually has its content width (not collapsed to 0).
		expect(box!.width).toBeGreaterThan(120);
	});

	test('iPhone-14: model-card popover escapes the rail and stays substantially on-screen', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		await page.waitForLoadState('domcontentloaded');

		const card = await openViirsModelCard(page);
		// The fix's contract: the popover is portaled out of the rail (no longer
		// clipped at the rail edge) and renders with real content width.
		const insideRail = await card.evaluate((el) => el.closest('.layer-rail') !== null);
		expect(insideRail).toBe(false);
		const box = await card.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.width).toBeGreaterThan(120);
		// Fully on-screen: `strategy: 'fixed'` measures floating-ui's shift()
		// against the visual viewport (not the portaled positioner's clipping
		// ancestors), and `overflowPadding: 8` insets it — so the panel that
		// previously spilled ~5px past the 390px edge now stays within it.
		expect(box!.x + box!.width).toBeLessThanOrEqual(390);
	});
});
