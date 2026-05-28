import { expect, test } from '@playwright/test';

// PR-B: MODIS Terra clouds — first NASA GIBS atmospheric overlay. The toggle
// lives in the LayerRail; flipping it on should kick MapLibre to fetch tiles
// through `/api/raster?layer=clouds-modis-terra&kind=atmospheric&...`, which
// the service worker buckets into `darkmap-atmospheric-tile`. The e2e asserts
// the proxy contract — if the network shape is right, both the MapLibre
// `addSource` call and the SW bucket attribution follow for free.

test.describe('Atmospheric layer: MODIS Terra clouds', () => {
	test('toggling the layer triggers a proxied GIBS tile fetch with kind=atmospheric', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });

		// Wait for the proxy request before the toggle is even fully settled so we
		// don't race the first paint.
		const atmosphericTileRequest = page.waitForRequest(
			(req) =>
				req.url().includes('/api/raster') &&
				req.url().includes('layer=clouds-modis-terra') &&
				req.url().includes('kind=atmospheric'),
			{ timeout: 15_000 },
		);

		await page.goto('/');
		await page.waitForLoadState('networkidle');

		// LayerRail exposes one toggle per layer with `aria-label="{label} toggle"`.
		const cloudsToggle = page.getByRole('checkbox', { name: /Clouds \(MODIS Terra\)/i });
		await expect(cloudsToggle).toBeVisible();
		await expect(cloudsToggle).not.toBeChecked();
		await cloudsToggle.check();
		await expect(cloudsToggle).toBeChecked();

		const req = await atmosphericTileRequest;
		const url = new URL(req.url());
		expect(url.searchParams.get('layer')).toBe('clouds-modis-terra');
		expect(url.searchParams.get('kind')).toBe('atmospheric');
		expect(url.searchParams.get('z')).toMatch(/^\d+$/);
	});

	test('toggling off re-checks to false; opacity slider becomes interactive when on', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const cloudsToggle = page.getByRole('checkbox', { name: /Clouds \(MODIS Terra\)/i });
		await cloudsToggle.check();
		await expect(cloudsToggle).toBeChecked();

		const opacitySlider = page.getByRole('slider', { name: /Clouds \(MODIS Terra\) opacity/i });
		await expect(opacitySlider).toBeEnabled();

		await cloudsToggle.uncheck();
		await expect(cloudsToggle).not.toBeChecked();
		// Slider disables when the layer is off (matches the pattern for VIIRS / World Atlas rows).
		await expect(opacitySlider).toBeDisabled();
	});
});
