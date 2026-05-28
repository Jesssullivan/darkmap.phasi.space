import { expect, test } from '@playwright/test';

// PR-I: opening the transmission widget from an atmospheric LayerRail row.
// Asserts the (i) Info chevron surfaces a sheet that calls
// /spectral-lut.json and then renders a curve.

test.describe('Atmospheric transmission widget', () => {
	test('Info chevron on the MODIS Terra row opens the transmission sheet', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		// Expand the Atmosphere section (default-collapsed per PR-E).
		const atmosphereHeader = page.getByRole('button', { name: /^Atmosphere/i });
		await atmosphereHeader.click();

		// Each atmospheric row has an Info chevron labelled "<layer> — open transmission sheet".
		const infoBtn = page.getByRole('button', { name: /Clouds \(MODIS Terra\).*transmission sheet/i });
		await expect(infoBtn).toBeVisible();

		const lutRequestPromise = page.waitForRequest((req) => req.url().includes('/spectral-lut.json'), {
			timeout: 10_000,
		});
		await infoBtn.click();
		await lutRequestPromise;

		// Sheet header + chart should be visible.
		await expect(page.getByRole('dialog', { name: /Atmospheric transmission/i })).toBeVisible();
		await expect(page.getByRole('img', { name: /Transmission curve from 0\.3 to 30 µm/i })).toBeVisible();
		await expect(page.getByText(/Engineering estimate/i)).toBeVisible();
		await expect(page.getByText(/NASA GIBS/i)).toBeVisible();

		// Close button dismisses.
		await page.getByRole('button', { name: /Close transmission sheet/i }).click();
		await expect(page.getByRole('dialog', { name: /Atmospheric transmission/i })).not.toBeVisible();
	});
});
