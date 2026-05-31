import { expect, test } from '@playwright/test';
import { openTransmissionSheet } from './transmission-helpers';

// V3-4: the directable boresight. The sheet hosts a look-angle control —
// target (Zenith/Sun/Moon/Manual) + azimuth/elevation sliders + a derived
// zenith/airmass readout. This spec covers the deterministic, network-free path
// (Manual dialing); sun/moon snap + terrain occlusion depend on live elevation
// tiles + ephemeris and are exercised by the unit-tested geometry core instead.

test.describe('Transmission boresight — directable look-angle', () => {
	test('defaults to zenith; Manual dialing updates the zenith + airmass readout', async ({ page }) => {
		const sheet = await openTransmissionSheet(page, { waitForLut: true });
		await expect(sheet).toBeVisible();

		// Default boresight is the local zenith.
		const targets = sheet.getByRole('radiogroup', { name: /Boresight target/i });
		await expect(targets.getByRole('radio', { name: 'Zenith' })).toHaveAttribute('aria-checked', 'true');

		// Derived readout: zenith 0°, airmass ~1.00 straight up.
		const derived = sheet.locator('.derived');
		await expect(derived).toContainText('0°');
		await expect(derived).toContainText('1.00');

		// Elevation slider is disabled until Manual is chosen.
		const elevation = sheet.getByRole('slider', { name: /Boresight elevation/i });
		await expect(elevation).toBeDisabled();

		// Switch to Manual → sliders enable.
		await targets.getByRole('radio', { name: 'Manual' }).click();
		await expect(elevation).toBeEnabled();

		// Dial elevation to the horizon (Home → min 0°) → zenith 90°, airmass undefined.
		await elevation.focus();
		await page.keyboard.press('Home');
		await expect(derived).toContainText('90°');
		await expect(derived).toContainText('—');
	});
});
