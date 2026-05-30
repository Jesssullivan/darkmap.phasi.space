import { expect, test } from '@playwright/test';

/**
 * Guided tour (#... discoverability). Pure DOM (no WebGL / map canvas needed),
 * so it render-checks fully headless: the toolbar replay button opens the tour,
 * the spotlight + step card render, steps advance and prepare the app state
 * (expanding the Atmosphere section), and Done closes it.
 *
 * First-run auto-start is suppressed via the localStorage flag so the replay
 * path is tested deterministically.
 */
test.describe('Guided tour', () => {
	test('toolbar button opens the tour; steps advance and Done closes it', async ({ page }) => {
		// Suppress the first-visit auto-tour so we drive the replay path explicitly.
		// (An init script re-runs on every navigation, which is what we want here —
		// the flag stays set the whole test.)
		await page.addInitScript(() => localStorage.setItem('darkmap-tour-v1', '1'));
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/');
		await page.waitForLoadState('domcontentloaded');

		const tourBtn = page.getByRole('button', { name: /Take the guided tour/i });
		await expect(tourBtn).toBeVisible();
		await tourBtn.click();

		const dialog = page.getByRole('dialog', { name: /Guided tour/i });
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText(/Layers live here/i);
		await expect(dialog).toContainText(/1 \/ 4/);

		// Step 2 — the atmosphere/spectral step; its prepare() expands the section.
		await dialog.getByRole('button', { name: /^Next$/ }).click();
		await expect(dialog).toContainText(/spectral transmission/i);
		await expect(page.getByRole('button', { name: /Open spectral transmission analysis/i })).toBeVisible();

		// Advance to the final step → the primary action becomes "Done".
		await dialog.getByRole('button', { name: /^Next$/ }).click();
		await dialog.getByRole('button', { name: /^Next$/ }).click();
		await dialog.getByRole('button', { name: /^Done$/ }).click();
		await expect(dialog).not.toBeVisible();
	});

	test('first-run auto-starts the tour once, then never again', async ({ page }) => {
		// Fresh context, NO flag manipulation — the app itself sets the flag on
		// first run, so the reload check exercises the real "once" behavior.
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/');
		await page.waitForLoadState('domcontentloaded');

		// Auto-starts after a short settle delay.
		const dialog = page.getByRole('dialog', { name: /Guided tour/i });
		await expect(dialog).toBeVisible({ timeout: 5_000 });
		await expect(dialog).toContainText(/Layers live here/i);
		await dialog.getByRole('button', { name: /^Skip$/ }).click();
		await expect(dialog).not.toBeVisible();

		// Reload — the app set the flag on first run, so it must NOT auto-start again.
		await page.reload();
		await page.waitForLoadState('domcontentloaded');
		await page.waitForTimeout(2_000);
		await expect(dialog).toHaveCount(0);
	});
});
