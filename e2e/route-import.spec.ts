import { expect, test } from '@playwright/test';

// Route import flow (#104). The hidden <input type="file"> accepts a
// synthetic file via Playwright's setInputFiles so the test never depends on
// a real upload dialog. The acceptance criteria are all local-only by design.

const SAMPLE_GPX = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Sample Loop</name>
    <trkseg>
      <trkpt lat="44.500" lon="-73.000"><ele>500</ele></trkpt>
      <trkpt lat="44.510" lon="-73.010"><ele>520</ele></trkpt>
      <trkpt lat="44.520" lon="-73.020"><ele>540</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

test.describe('Route import', () => {
	test('imports a GPX file via the toolbar picker, then clears it', async ({ page }) => {
		await page.setViewportSize({ width: 1024, height: 768 });
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const importBtn = page.getByRole('button', { name: /import .* route/i });
		await expect(importBtn).toHaveAttribute('aria-pressed', 'false');

		const fileChooserPromise = page.waitForEvent('filechooser');
		await importBtn.click();
		const chooser = await fileChooserPromise;
		await chooser.setFiles({ name: 'sample.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(SAMPLE_GPX) });

		// Success toast and toolbar flip to "Clear" state.
		await expect(page.getByText(/Loaded Sample Loop/)).toBeVisible({ timeout: 5000 });
		const clearBtn = page.getByRole('button', { name: /clear imported route/i });
		await expect(clearBtn).toHaveAttribute('aria-pressed', 'true');

		// Toggle off — toolbar returns to the import label.
		await clearBtn.click();
		await expect(page.getByRole('button', { name: /import .* route/i })).toHaveAttribute('aria-pressed', 'false');
	});

	test('shows a toast and stays cleared for an invalid file', async ({ page }) => {
		await page.setViewportSize({ width: 1024, height: 768 });
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const importBtn = page.getByRole('button', { name: /import .* route/i });
		const fileChooserPromise = page.waitForEvent('filechooser');
		await importBtn.click();
		const chooser = await fileChooserPromise;
		await chooser.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello world') });

		// Toast carries the parser's "unsupported route import format" message.
		await expect(page.getByText(/unsupported route import format/i)).toBeVisible({ timeout: 5000 });
		// Button stays in the "import" state because nothing was loaded.
		await expect(importBtn).toHaveAttribute('aria-pressed', 'false');
	});
});
