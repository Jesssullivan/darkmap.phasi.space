import { expect, test } from '@playwright/test';
import { openTransmissionSheet } from './transmission-helpers';

// UX-1: the transmission sheet and the point readout both anchored bottom-right
// (desktop) and bottom (mobile), so the sheet covered the readout it was opened
// from. The fix hides the readout while the sheet is open (the sheet is a
// drill-down of the same point and carries its coords in the header), and
// restores it on close. This guards that de-pile at desktop + phone widths.

for (const vp of [
	{ label: 'desktop', width: 1280, height: 800 },
	{ label: 'phone', width: 390, height: 844 },
]) {
	test(`readout hides while the sheet is open and returns on close (${vp.label})`, async ({ page }) => {
		const sheet = await openTransmissionSheet(page, { width: vp.width, height: vp.height, waitForLut: true });
		await expect(sheet).toBeVisible();

		// The readout that launched the sheet is hidden (no more stacking).
		await expect(page.locator('.readout[role=dialog]')).toHaveCount(0);
		// Its context is preserved: the sheet header shows the point coords.
		await expect(sheet.getByText(/for -?\d+\.\d+°,\s*-?\d+\.\d+°/)).toBeVisible();

		// Closing the sheet restores the readout.
		await page.getByRole('button', { name: /Close transmission sheet/i }).click();
		await expect(sheet).not.toBeVisible();
		await expect(page.locator('.readout[role=dialog]')).toBeVisible();
	});
}
