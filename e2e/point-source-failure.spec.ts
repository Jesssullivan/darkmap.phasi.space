import { expect, test } from '@playwright/test';

test('a denied raster read clears its prior values while atmosphere and AQ remain visible', async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('darkmap-tour-v1', '1'));
	let pointRequests = 0;
	await page.route('**/api/featureinfo?*', (route) => {
		pointRequests += 1;
		if (pointRequests === 1) {
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					viirs: { layer: 'PostGIS:VIIRS_2019', red: 20, green: 30, blue: 40, alpha: 255 },
					worldAtlas: { grayIndex: 1.23 },
				}),
			});
		}
		return route.fulfill({
			status: 403,
			contentType: 'application/json',
			body: '{"message":"upstream point-query error"}',
		});
	});
	await page.route('**/api/atmospheric/point?*', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				matchedTime: '2026-09-26T12:00',
				pwv: 12,
				rh: 55,
				cloudLow: 10,
				cloudMid: 5,
				cloudHigh: 0,
				visibility: 24000,
			}),
		}),
	);
	await page.route('**/api/atmospheric/airquality?*', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ matchedTime: '2026-09-26T12:00', pm25: 8, aod550: 0.1 }),
		}),
	);

	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/');
	await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
	await page.mouse.click(400, 400);
	const readout = page.locator('.readout[role=dialog]');
	await expect(readout.getByText('VIIRS pixel')).toBeVisible();
	await expect(readout.getByText('World Atlas radiance')).toBeVisible();

	await page.mouse.click(450, 420);
	await expect(readout.getByText('VIIRS and World Atlas readings are unavailable from their source.')).toBeVisible();
	await expect(readout.getByText('VIIRS pixel')).toHaveCount(0);
	await expect(readout.getByText('World Atlas radiance')).toHaveCount(0);
	await expect(readout.getByText('Atmosphere (Open-Meteo)')).toBeVisible();
	await readout.getByRole('button', { name: /^More — \d+ sections?/ }).click();
	await expect(readout.getByText('Pollen & air quality')).toBeVisible();
	await expect(readout.getByText('No data at this point.')).toHaveCount(0);
	expect(pointRequests).toBe(2);
});
