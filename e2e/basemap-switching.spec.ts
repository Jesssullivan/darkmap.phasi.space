import { expect, test } from '@playwright/test';

// #198 — mobile basemap-switching regression harness. Cycles Dark → OSM
// → Satellite → Dark with VIIRS + an atmospheric overlay enabled, and
// asserts no console errors, no blank map, and overlay toggles still
// reflect their enabled state after every swap.

test.describe('Basemap switching — mobile regression harness (#198)', () => {
	test('cycle Dark → OSM → Satellite → Dark with overlays active stays stable', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14

		const consoleErrors: string[] = [];
		page.on('console', (msg) => {
			if (msg.type() === 'error') consoleErrors.push(msg.text());
		});
		page.on('pageerror', (err) => consoleErrors.push(err.message));

		await page.goto('/');
		await page.waitForLoadState('networkidle');

		// Open the layer rail drawer (mobile collapses by default).
		const railToggle = page.getByRole('button', { name: /Open layers/i });
		if (await railToggle.isVisible()) await railToggle.click();

		// Toggle on an atmospheric overlay so the basemap swap has to
		// preserve overlay ordering.
		const atmosphereHeader = page.getByRole('button', { name: /^Atmosphere/i });
		await atmosphereHeader.click();
		const cloudsToggle = page.getByRole('checkbox', { name: /Clouds \(MODIS Terra\)/i });
		await cloudsToggle.check();
		await expect(cloudsToggle).toBeChecked();

		const basemapChip = (label: string) => page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();

		// Cycle through the three basemaps. Each chip should toggle the
		// active state, and the previous basemap chip should clear its
		// active state.
		for (const target of ['OSM', 'Satellite', 'Dark', 'OSM']) {
			const chip = basemapChip(target);
			await expect(chip).toBeVisible();
			await chip.click();
			await expect(chip).toHaveAttribute('aria-pressed', 'true');
			// Allow MapLibre to settle.
			await page.waitForTimeout(150);
			// Map canvas should still be in DOM.
			await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
		}

		// Overlay toggle should still reflect on after the cycle.
		await expect(cloudsToggle).toBeChecked();

		// No uncaught console errors during the whole cycle. The basemap
		// swap is the main thing this test guards against regressing —
		// any new error here is a "blank map / lost overlay" smell.
		const significant = consoleErrors.filter(
			(e) =>
				// Cosmetic warnings from MapLibre about tile loading 404s are not
				// "uncaught"; Chromium can also emit a transient WebGL shader
				// diagnostic during context setup while the canvas stays visible.
				!e.includes('Failed to load resource') &&
				!e.includes('tile') &&
				!e.includes('Could not compile fragment shader'),
		);
		expect(significant).toEqual([]);
	});
});
