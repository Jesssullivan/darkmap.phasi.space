import { expect, test } from '@playwright/test';
import { openTransmissionSheet } from './transmission-helpers';

/**
 * Spectral-usability pass — the sheet itself is inline SVG (no WebGL), but V3
 * makes it point-anchored: it opens from the PointReadout for a selected map
 * point. `openTransmissionSheet` drives that flow. Asserts the laser/EO band
 * quick-select reads T off the curve, the band guidance is a prominent callout,
 * and the Ångström slider shows its Mie-derived state instead of a dead control.
 */

test.describe('Spectral transmission — band quick-select + guidance', () => {
	test('band presets read T(λ); guidance callout renders', async ({ page }) => {
		const sheet = await openTransmissionSheet(page, { height: 900 });
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
		const sheet = await openTransmissionSheet(page, { height: 900 });
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
