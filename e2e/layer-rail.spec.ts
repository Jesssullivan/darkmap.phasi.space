import { expect, test } from '@playwright/test';

test.describe('Layer rail — public light-pollution overlays', () => {
	test('mobile rail exposes styled World Atlas but not the raw overlay toggle', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const railToggle = page.getByRole('button', { name: /Open layers/i });
		if (await railToggle.isVisible()) await railToggle.click();

		await expect(page.getByRole('checkbox', { name: /^World Atlas 2015$/i })).toBeVisible();
		await expect(page.getByText('World Atlas 2015 (raw)', { exact: true })).toHaveCount(0);
	});
});
