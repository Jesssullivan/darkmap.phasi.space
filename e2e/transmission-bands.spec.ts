import { expect, test, type Page } from '@playwright/test';

/**
 * Spectral-usability pass — render-verified, headless (the sheet is inline SVG,
 * no WebGL): the laser/EO band quick-select reads T off the curve, the band
 * guidance is surfaced as a prominent callout, and the Ångström slider shows its
 * Mie-derived state instead of a dead disabled control.
 */
const openSheet = async (page: Page): Promise<void> => {
	// Suppress the first-run tour so it doesn't cover the rail.
	await page.addInitScript(() => localStorage.setItem('darkmap-tour-v1', '1'));
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/');
	await page.waitForLoadState('domcontentloaded');
	const railToggle = page.getByRole('button', { name: /Open layers/i });
	if (await railToggle.isVisible().catch(() => false)) await railToggle.click();
	const atmo = page.getByRole('button', { name: /^Atmosphere/i });
	if ((await atmo.getAttribute('aria-expanded')) !== 'true') await atmo.click();
	await page.getByRole('button', { name: /Open spectral transmission analysis/i }).click();
};

test.describe('Spectral transmission — band quick-select + guidance', () => {
	test('band presets read T(λ); guidance callout renders', async ({ page }) => {
		await openSheet(page);
		const sheet = page.getByRole('dialog', { name: /Atmospheric transmission/i });
		await expect(sheet).toBeVisible();
		// The curve computes from the LUT (fetch + Effect) — allow headroom under
		// parallel-worker load before the chart paints.
		await expect(sheet.getByRole('img', { name: /Transmission curve/i })).toBeVisible({ timeout: 20_000 });

		// Quick-select chips render (laser line + window).
		const group = sheet.getByRole('group', { name: /band quick-select/i });
		await expect(group.getByRole('button', { name: '1064 nm' })).toBeVisible();
		await expect(group.getByRole('button', { name: 'SWIR' })).toBeVisible();

		// Selecting a band reads T off the curve + shows a verdict.
		await group.getByRole('button', { name: '1064 nm' }).click();
		const readout = sheet.locator('.preset-readout');
		await expect(readout).toContainText(/T ≈ \d+%/);
		await expect(readout.locator('.verdict')).toBeVisible();

		// The "pick a working band" guidance is a prominent callout.
		await expect(sheet.locator('.band-guidance')).toBeVisible();
	});

	test('Ångström slider shows its Mie-derived state when an aerosol type is active', async ({ page }) => {
		await openSheet(page);
		const sheet = page.getByRole('dialog', { name: /Atmospheric transmission/i });
		await expect(sheet).toBeVisible();

		const angstrom = sheet.getByRole('slider', { name: /Ångström exponent slider/i });
		await expect(angstrom).toBeEnabled(); // manual in LUT-only mode

		// Switch on a live-Mie aerosol type (first chip after "Off").
		const aerosol = sheet.getByRole('radiogroup', { name: /Aerosol type/i });
		await aerosol.getByRole('button').nth(1).click();

		await expect(angstrom).toBeDisabled();
		await expect(sheet.locator('.derived-tag')).toHaveText(/Mie/i);
	});
});
