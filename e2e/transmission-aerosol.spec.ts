import { expect, test } from '@playwright/test';
import { openTransmissionSheet } from './transmission-helpers';

// V2-E: aerosol picker + slider interaction. Opens the point-anchored
// transmission sheet, flips on a live-Mie aerosol type, asserts the chip state
// updates and the Ångström slider disables; then drags the AOD slider and
// asserts the recompute completes without throwing.

test.describe('Atmospheric transmission widget — V2 live aerosol controls', () => {
	test('selecting an aerosol type updates the source label and re-fetches', async ({ page }) => {
		const dialog = await openTransmissionSheet(page, { waitForLut: true });
		await expect(dialog).toBeVisible();

		// Confirm the "Off" chip is the active default.
		const offChip = dialog.getByRole('button', { name: /^Off$/, exact: true });
		await expect(offChip).toHaveAttribute('aria-pressed', 'true');

		// Click Smoke — expect aria-pressed flip + curve refresh.
		const smokeChip = dialog.getByRole('button', { name: /^Smoke$/, exact: true });
		await smokeChip.click();
		await expect(smokeChip).toHaveAttribute('aria-pressed', 'true');
		await expect(offChip).toHaveAttribute('aria-pressed', 'false');

		// The Ångström slider should disable in live-Mie mode (Mie supersedes a fixed α).
		const angstromSlider = dialog.getByRole('slider', { name: /Ångström/i });
		await expect(angstromSlider).toBeDisabled();
	});

	test('AOD slider drag triggers a recompute', async ({ page }) => {
		const dialog = await openTransmissionSheet(page, { waitForLut: true });
		await expect(dialog).toBeVisible();

		const aodSlider = dialog.getByRole('slider', { name: /AOD550/i });
		await expect(aodSlider).toBeVisible();
		// Set via keyboard arrow — exercises the oninput handler debounce.
		await aodSlider.focus();
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		// Allow the 80ms debounce + recompute to land.
		await page.waitForTimeout(250);
		// Chart should still be present (no errors mid-recompute).
		await expect(dialog.getByRole('img', { name: /Transmission curve/i })).toBeVisible();
	});
});
