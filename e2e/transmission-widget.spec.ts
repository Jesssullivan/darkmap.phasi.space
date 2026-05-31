import { expect, test } from '@playwright/test';
import { openTransmissionSheet } from './transmission-helpers';

// V3: the transmission widget opens from the PointReadout CTA (point-anchored),
// not the old LayerRail (i) chevron. Asserts the sheet fetches /spectral-lut.json
// and renders a curve for the selected point.

test.describe('Atmospheric transmission widget', () => {
	test('opens from the point readout and renders the curve', async ({ page }) => {
		const sheet = await openTransmissionSheet(page, { waitForLut: true });

		// Sheet header + chart should be visible.
		await expect(sheet).toBeVisible();
		await expect(page.getByRole('img', { name: /Transmission curve from 0\.3 to 30 µm/i })).toBeVisible();
		await expect(page.getByText(/Engineering estimate/i)).toBeVisible();
		await expect(page.getByRole('link', { name: /NASA GIBS/i })).toBeVisible();

		// Close button dismisses.
		await page.getByRole('button', { name: /Close transmission sheet/i }).click();
		await expect(page.getByRole('dialog', { name: /Atmospheric transmission/i })).not.toBeVisible();
	});
});
