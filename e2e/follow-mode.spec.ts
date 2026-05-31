import { expect, test } from '@playwright/test';

// GPS follow mode happy path (#124). Mocks geolocation so the test never
// touches a real device GPS, then verifies that toggling the follow button
// drops a marker on the map at the mocked coordinate and toggles back off
// cleanly.

const MOCK_LAT = 44.5;
const MOCK_LON = -73.0;

test.describe('GPS follow mode', () => {
	test.beforeEach(async ({ context }) => {
		await context.grantPermissions(['geolocation']);
		await context.setGeolocation({ latitude: MOCK_LAT, longitude: MOCK_LON, accuracy: 18 });
	});

	test('toggle on adds a follow marker; toggle off removes it', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		// MapLibre marker root is rendered as a maplibregl-marker child carrying
		// our custom .follow-marker element. Initially absent.
		await expect(page.locator('.follow-marker')).toHaveCount(0);

		const followToggle = page.getByRole('button', { name: /follow/i });
		await followToggle.click();

		// Marker appears once the watch delivers the first position. Mocked
		// geolocation resolves synchronously enough that we can wait modestly.
		await expect(page.locator('.follow-marker')).toBeVisible({ timeout: 5000 });
		await expect(followToggle).toHaveAttribute('aria-pressed', 'true');

		// Marker carries the accuracy in its tooltip.
		await expect(page.locator('.follow-marker')).toHaveAttribute('title', /±18 m/);

		// Toggle off.
		await followToggle.click();
		await expect(page.locator('.follow-marker')).toHaveCount(0);
		await expect(followToggle).toHaveAttribute('aria-pressed', 'false');
	});

	test('denied permission surfaces a toast and stays off', async ({ context, page }) => {
		await context.clearPermissions();
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const followToggle = page.getByRole('button', { name: /follow/i });
		await followToggle.click();

		// No marker appears; toggle returns to off; a toast surfaces.
		await expect(page.locator('.follow-marker')).toHaveCount(0);
		// Toast text comes from handleFollowError('denied').
		await expect(page.getByText(/permission denied/i)).toBeVisible({ timeout: 5000 });
		await expect(followToggle).toHaveAttribute('aria-pressed', 'false');
	});
});
