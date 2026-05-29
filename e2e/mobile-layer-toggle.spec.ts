import { expect, test, type Page } from '@playwright/test';

/**
 * #237 — mobile layer-toggle suite. On an iPhone-14 viewport, walk the
 * LayerRail toggles and assert each layer reaches an honest state:
 *
 *   - light-pollution rasters (VIIRS, World Atlas) → map canvas stays
 *     alive after toggle (the render path; these don't surface a pill).
 *   - atmospheric overlays → each reaches the active path (fetches a tile
 *     through the proxy) rather than a silent dead toggle, and any pill it
 *     does surface carries a valid degraded state. The LayerRail shows a
 *     pill only for degraded states (#248) — a healthy "rendered" layer
 *     shows none — so the contract is rendered-OR-explicit-degraded.
 *   - the console stays free of uncaught MapLibre / source lifecycle
 *     errors during a rapid on/off toggle storm.
 *
 * Also pins the #247 acceptance: the raw World Atlas toggle is gone from
 * the public rail.
 */

const IPHONE_14 = { width: 390, height: 844 };

// Atmospheric overlays. Each must reach the active path (fetch a tile
// through the proxy) on toggle; the LayerRail surfaces a health pill only
// for DEGRADED states (loading / no data / stale / error) — a healthy
// "rendered" layer intentionally shows no pill, so the assertion is
// rendered-OR-explicit-degraded, not "always a pill".
const ATMOSPHERIC = [
	{ id: 'clouds-modis-terra', label: /Clouds \(MODIS Terra\)/i },
	{ id: 'clouds-viirs-noaa20', label: /Clouds \(VIIRS NOAA-20\)/i },
	{ id: 'aerosol-modis-aod', label: /Aerosol AOD \(MODIS\)/i },
	{ id: 'water-vapor-airs', label: /Water vapor \(MODIS Terra\)/i },
] as const;

const HEALTH_STATE = /loading|live|cache|cached|no data|stale|error|offline/i;

const openRail = async (page: Page): Promise<void> => {
	const railToggle = page.getByRole('button', { name: /Open layers/i });
	if (await railToggle.isVisible()) await railToggle.click();
};

const openAtmosphere = async (page: Page): Promise<void> => {
	const header = page.getByRole('button', { name: /^Atmosphere/i });
	await expect(header).toBeVisible();
	if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
};

/** The <li> row that contains a given checkbox — lets us scope the pill query. */
const rowFor = (page: Page, label: RegExp) => page.locator('li', { has: page.getByRole('checkbox', { name: label }) });

const captureConsole = (page: Page): string[] => {
	const errors: string[] = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});
	page.on('pageerror', (err) => errors.push(err.message));
	return errors;
};

// Tile 404/Failed-to-load noise is expected (no-data tiles, sparse upstream)
// and is NOT an uncaught lifecycle error.
const significant = (errors: string[]): string[] =>
	errors.filter((e) => !e.includes('Failed to load resource') && !e.includes('tile') && !/40\d|50\d/.test(e));

test.describe('Mobile layer-toggle suite (#237)', () => {
	test('the raw World Atlas overlay is not offered in the rail (#247)', async ({ page }) => {
		await page.setViewportSize(IPHONE_14);
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		await openRail(page);
		// Styled World Atlas is present; the raw variant is gone.
		await expect(page.getByRole('checkbox', { name: /World Atlas 2015$/i })).toHaveCount(1);
		await expect(page.getByRole('checkbox', { name: /World Atlas 2015 \(raw\)/i })).toHaveCount(0);
	});

	test('light-pollution rasters toggle without tearing down the map', async ({ page }) => {
		await page.setViewportSize(IPHONE_14);
		const errors = captureConsole(page);
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		await openRail(page);

		for (const label of [/VIIRS Annual/i, /World Atlas 2015$/i]) {
			const toggle = page.getByRole('checkbox', { name: label });
			await expect(toggle).toBeVisible();
			await toggle.check();
			await expect(toggle).toBeChecked();
			await page.waitForTimeout(150);
			await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
		}
		expect(significant(errors)).toEqual([]);
	});

	test('every atmospheric overlay mounts + fetches through the proxy (rendered-or-degraded)', async ({ page }) => {
		await page.setViewportSize(IPHONE_14);
		await page.goto('/#m=40,-100,4');
		await page.waitForLoadState('networkidle');
		await openRail(page);
		await openAtmosphere(page);

		for (const { id, label } of ATMOSPHERIC) {
			const toggle = page.getByRole('checkbox', { name: label });
			await expect(toggle).toBeVisible();
			// The layer is "rendered/active" iff it fetches tiles through the
			// proxy. The protocol loader's fetch is observable here.
			const tileRequest = page.waitForRequest(
				(r) =>
					r.url().includes('/api/raster') && r.url().includes(`layer=${id}`) && r.url().includes('kind=atmospheric'),
				{ timeout: 20_000 },
			);
			await toggle.check();
			await expect(toggle).toBeChecked();
			await tileRequest; // proves it reached the active fetch path, not a silent dead toggle
			// If a degraded pill surfaced (loading/no-data/stale/error), it must
			// carry a valid state — never a blank/garbage pill. A healthy layer
			// shows no pill, which is the correct "rendered" signal.
			const pill = rowFor(page, label).locator('.health-pill');
			if ((await pill.count()) > 0 && (await pill.isVisible())) {
				await expect(pill).toHaveText(HEALTH_STATE);
			}
			await toggle.uncheck();
		}
	});

	test('rapid toggle storm keeps the console free of lifecycle errors', async ({ page }) => {
		await page.setViewportSize(IPHONE_14);
		const errors = captureConsole(page);
		await page.goto('/#m=40,-100,4');
		await page.waitForLoadState('networkidle');
		await openRail(page);
		await openAtmosphere(page);

		// Flip every atmospheric overlay on, then off, with minimal settle —
		// the kind of churn that surfaces MapLibre source add/remove races.
		for (const { label } of ATMOSPHERIC) {
			await page.getByRole('checkbox', { name: label }).check();
		}
		await page.waitForTimeout(200);
		for (const { label } of ATMOSPHERIC) {
			await page.getByRole('checkbox', { name: label }).uncheck();
		}
		await page.waitForTimeout(200);
		await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
		expect(significant(errors)).toEqual([]);
	});
});
