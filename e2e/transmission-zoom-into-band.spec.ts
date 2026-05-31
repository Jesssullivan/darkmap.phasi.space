import { expect, test } from '@playwright/test';
import { openTransmissionSheet } from './transmission-helpers';

// V3b-5: zoom-into-band flow. Opens the point-anchored transmission sheet,
// clicks a band chip, asserts the detail panel renders the LBL curve, then the
// "Back to spectrum" button restores the main view.

test.describe('Atmospheric transmission widget — V3b band zoom', () => {
	test('clicking an H2O band chip opens the LBL detail panel and back restores', async ({ page }) => {
		const dialog = await openTransmissionSheet(page, { waitForLut: true });
		await expect(dialog).toBeVisible();

		// Click the H2O ψ (1380 nm) chip — strongest H2O band, easy to verify.
		const bandChip = dialog.getByRole('button', { name: /H₂O ψ \(1380 nm\)/i });
		await expect(bandChip).toBeVisible();
		const lblRequest = page.waitForRequest((req) => req.url().includes('/spectral-lbl/h2o-1380nm.json'), {
			timeout: 10_000,
		});
		await bandChip.click();
		await lblRequest;

		// Detail panel header + chart should render.
		const detail = dialog.getByRole('region', { name: /Band detail/i });
		await expect(detail).toBeVisible();
		await expect(detail.getByRole('img', { name: /H₂O ψ \(1380 nm\) line-by-line transmission/i })).toBeVisible();

		// Back button restores main spectrum (chart with the engineering-estimate disclaimer).
		await detail.getByRole('button', { name: /Back to spectrum/i }).click();
		await expect(detail).not.toBeVisible();
		await expect(dialog.getByRole('img', { name: /Transmission curve from 0\.3 to 30 µm/i })).toBeVisible();
	});
});
