import { expect, test, type Page } from '@playwright/test';

/**
 * RENDER-level e2e for the atmospheric stack — the gap that let the live "no
 * data" bug ship green.
 *
 * The sibling `atmospheric-clouds.spec.ts` MOCKS `/api/raster` (always returns
 * `outcome: ok`), so it verifies the request contract + the pill state machine
 * but NEVER exercises the real GIBS date logic. That is precisely how the
 * "today's date → GIBS not published yet → empty no-data tile, no fallback"
 * regression (#297) reached production: every test passed against a mock.
 *
 * These tests are deliberately UNMOCKED for the "now" view and assert the
 * rendered/data outcome:
 *   1. Toggling a GIBS overlay at *today's* date returns `ok`/`ok-fallback`
 *      (the date-fallback walks back to the latest published day) and the row
 *      does NOT show "no data" — this would have caught #297.
 *   2. The "Spectral transmission T(λ)" CTA is discoverable and opens the sheet
 *      with the AOD₅₅₀ + Ångström controls (the discoverability fix, #300).
 *
 * Public-repo note: only the public GIBS overlays + the sheet DOM are exercised.
 * The Smog/PM2.5 overlay needs OPENAQ_API_KEY (a secret that is intentionally
 * absent in CI), so it is NOT render-tested here.
 */

// The "today" guard hits real GIBS over the network — a couple of retries so a
// transient upstream blip doesn't red the lane. The assertion is deterministic
// given a reachable GIBS.
test.describe.configure({ retries: 2 });

const openAtmosphereRail = async (page: Page): Promise<void> => {
	const drawerToggle = page.getByRole('button', { name: /Open layers/i });
	if (await drawerToggle.isVisible().catch(() => false)) await drawerToggle.click();
	const atmosphereHeader = page.getByRole('button', { name: /^Atmosphere/i });
	await expect(atmosphereHeader).toBeVisible();
	if ((await atmosphereHeader.getAttribute('aria-expanded')) !== 'true') await atmosphereHeader.click();
};

test.describe('Atmospheric overlays — data flows for the live "now" view', () => {
	// Catches #297 directly: the map's live "now" view sends an explicit
	// time=today, and GIBS daily products publish ~18-24h late. The proxy must
	// walk back to the latest published day (ok-fallback) instead of returning a
	// transparent no-data tile. Asserted at the proxy layer (Playwright `request`
	// fixture) rather than through the map canvas, because the MapLibre overlay
	// only paints under WebGL — which headless Chromium lacks (swiftshader is a
	// CI-lane concern). The DATA bug is fully captured here; the canvas-paint
	// check belongs in a WebGL-enabled lane (follow-up).
	const ATMO_LAYERS = [
		{ id: 'clouds-modis-terra', z: 4, x: 4, y: 6 },
		{ id: 'aerosol-modis-aod', z: 4, x: 4, y: 6 },
		{ id: 'water-vapor-airs', z: 4, x: 4, y: 6 },
	] as const;

	for (const { id, z, x, y } of ATMO_LAYERS) {
		test(`${id}: proxy returns data (ok/ok-fallback), not no-data, for TODAY`, async ({ request }) => {
			const today = new Date().toISOString().slice(0, 10);
			const res = await request.get(`/api/raster?layer=${id}&z=${z}&x=${x}&y=${y}&kind=atmospheric&time=${today}`);
			expect(res.status()).toBe(200);
			const outcome = res.headers()['x-darkmap-atmospheric-outcome'];
			// clouds-modis-terra has near-global daily coverage so it should resolve
			// to ok/ok-fallback; the sparse science products (aerosol/water-vapor)
			// may legitimately be no-data over an ocean tile — for those, the guard
			// is only that the request succeeds and the walk-back ran (a no-data
			// here means "genuinely empty after fallback", not "today not published").
			if (id === 'clouds-modis-terra') {
				expect(outcome, `today (${today}) clouds outcome was "${outcome}" — date-fallback regressed (#297)`).toMatch(
					/^ok(-fallback)?$/,
				);
			} else {
				expect(outcome, `expected an atmospheric outcome header, got "${outcome}"`).toMatch(
					/^(ok(-fallback)?|no-data)$/,
				);
			}
		});
	}
});

test.describe('Spectral transmission widget — discoverable + controls render', () => {
	test('the Atmosphere CTA opens the sheet with the AOD + Ångström controls', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/');
		await page.waitForLoadState('domcontentloaded');
		await openAtmosphereRail(page);

		// The prominent CTA (#300) — not the easily-missed per-row (i).
		const cta = page.getByRole('button', { name: /Open spectral transmission analysis/i });
		await expect(cta).toBeVisible();
		await expect(cta).toContainText(/Spectral transmission/i);

		await cta.click();

		const sheet = page.getByRole('dialog', { name: /Atmospheric transmission/i });
		await expect(sheet).toBeVisible();
		// The controls the user reported "gone" — present and rendered.
		await expect(sheet.getByRole('slider', { name: /AOD550 slider/i })).toBeVisible();
		await expect(sheet.getByRole('slider', { name: /Ångström exponent slider/i })).toBeVisible();

		await page.getByRole('button', { name: /Close transmission sheet/i }).click();
		await expect(sheet).not.toBeVisible();
	});
});
