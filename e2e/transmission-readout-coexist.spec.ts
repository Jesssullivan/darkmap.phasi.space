import { expect, test, type Locator } from '@playwright/test';
import { openTransmissionSheet } from './transmission-helpers';

// UX (S2): the transmission sheet used to UNMOUNT the point readout it was
// opened from — the deep tool occluded the overview. The fix (overview+detail,
// docs §11.5) keeps the readout mounted as the OVERVIEW alongside the docked
// detail sheet: the readout repositions (top-right on desktop, a compact top
// strip on mobile) and the two never overlap. This guards that coexistence at
// desktop + phone widths.

async function box(loc: Locator) {
	const b = await loc.boundingBox();
	expect(b, 'element should have a layout box').not.toBeNull();
	return b!;
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean =>
	a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

for (const vp of [
	{ label: 'desktop', width: 1280, height: 800 },
	{ label: 'phone', width: 390, height: 844 },
]) {
	test(`readout stays as the overview beside the sheet, non-overlapping (${vp.label})`, async ({ page }) => {
		const sheet = await openTransmissionSheet(page, { width: vp.width, height: vp.height, waitForLut: true });
		await expect(sheet).toBeVisible();

		// Overview+detail: the readout is NOT unmounted — it coexists with the sheet.
		const readout = page.locator('.readout[role=dialog]');
		await expect(readout).toBeVisible();
		// Its context is also echoed in the sheet header (the point coords).
		await expect(sheet.getByText(/for -?\d+\.\d+°,\s*-?\d+\.\d+°/)).toBeVisible();

		// The detail sheet must not cover the overview readout.
		expect(overlaps(await box(readout), await box(sheet)), 'sheet must not overlap the readout').toBe(false);

		// Closing the sheet returns the readout to its resting position.
		await page.getByRole('button', { name: /Close transmission sheet/i }).click();
		await expect(sheet).not.toBeVisible();
		await expect(readout).toBeVisible();
	});
}
