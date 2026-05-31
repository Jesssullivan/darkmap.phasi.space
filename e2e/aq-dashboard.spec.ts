import { expect, test, type Page } from '@playwright/test';

/**
 * V6-4 — the /aq air-quality analysis dashboard. Point-anchored, deep-linkable,
 * and honest: every series carries provenance + coverage, gaps stay gaps, and a
 * missing source is "no data", never agreement or clean air.
 *
 * These specs mock the three data proxies the dashboard fans out to so the
 * assertions are deterministic (the data-flow guards for each proxy live with
 * their own services). The openaq sensors station is placed AT the point so the
 * diffusion resolves a high-confidence value there.
 */

const SEED_HASH = '#m=34.05,-118.24,9&et=2026-05-30T12:00Z';

const sensorsBody = {
	type: 'FeatureCollection',
	degraded: false,
	features: [
		{
			type: 'Feature',
			properties: {
				locationName: 'Test Station',
				value: 12.3,
				pollutants: { pm25: { value: 12.3, units: 'µg/m³' }, o3: { value: 30, units: 'ppb' } },
				locationId: 1,
			},
			geometry: { type: 'Point', coordinates: [-118.24, 34.05] },
		},
	],
};

const airQualityBody = {
	matchedTime: '2026-05-30T12:00',
	pollen: { alder: null, birch: null, grass: null, mugwort: null, olive: null, ragweed: null },
	pm25: 9.1,
	pm10: 18,
	aod550: 0.12,
	dust: 2,
	ozone: 40,
};

const historyBody = (sampleCount: number) => ({
	series:
		sampleCount === 0
			? null
			: {
					parameter: 'pm25',
					units: 'µg/m³',
					// Two clustered hours then a gap then one more — exercises the gap break.
					points: [
						{ at: '2026-05-30T08:00:00Z', value: 6 },
						{ at: '2026-05-30T09:00:00Z', value: 8 },
						{ at: '2026-05-30T10:00:00Z', value: 7 },
						{ at: '2026-05-30T18:00:00Z', value: 11 },
					].slice(0, sampleCount),
					sampleCount,
					mean: 8,
					min: 6,
					max: 11,
					windowFrom: '2026-05-30T00:00:00Z',
					windowTo: '2026-05-30T23:00:00Z',
					latestAt: '2026-05-30T18:00:00Z',
					latestValue: 11,
					trend: 'rising',
					trendDelta: 3,
					stale: false,
				},
	degraded: false,
});

const mockDashboardApis = async (page: Page, opts: { historySamples?: number } = {}): Promise<void> => {
	const { historySamples = 4 } = opts;
	// `\/openaq\?` matches only the sensors endpoint (openaq-history has `-history` before the `?`).
	await page.route(/\/api\/atmospheric\/openaq\?/, (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sensorsBody) }),
	);
	await page.route(/\/api\/atmospheric\/openaq-history\?/, (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(historyBody(historySamples)) }),
	);
	await page.route(/\/api\/atmospheric\/airquality\?/, (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(airQualityBody) }),
	);
};

test.describe('AQ dashboard (/aq)', () => {
	test('empty state prompts for a location when there is no hash', async ({ page }) => {
		await page.goto('/aq');
		await expect(page.getByRole('heading', { name: 'Air-quality analysis' })).toBeVisible();
		await expect(page.getByText('Pick a location to analyze its air quality.')).toBeVisible();
		await expect(page.getByRole('searchbox')).toBeVisible();
		// No panels until a point is chosen.
		await expect(page.getByRole('heading', { name: 'Source cross-check' })).toHaveCount(0);
	});

	test('a seeded point renders all three panels with provenance + coverage', async ({ page }) => {
		await mockDashboardApis(page);
		await page.goto(`/aq${SEED_HASH}`);

		// Header reflects the seeded coordinate.
		await expect(page.getByText('34.0500, -118.2400')).toBeVisible();

		// Multi-pollutant + AQI panel: AQI badge + a PM2.5 row + honest provenance.
		await expect(page.getByRole('heading', { name: 'Multi-pollutant · AQI' })).toBeVisible();
		await expect(page.locator('.aqi-num')).toBeVisible();
		await expect(page.locator('.pollutant-list').getByText('PM2.5')).toBeVisible();
		await expect(page.getByText(/diffused to the point/i)).toBeVisible();

		// History panel: the chart renders and the gaps-stay-gaps caption is present.
		await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
		await expect(page.getByRole('img', { name: /hourly history/i })).toBeVisible();
		await expect(page.getByText(/gaps are left as gaps/i)).toBeVisible();

		// Cross-check panel: a comparison exists and the only-where-both caption is present.
		await expect(page.getByRole('heading', { name: 'Source cross-check' })).toBeVisible();
		await expect(page.getByText(/compared only where both reported a value/i)).toBeVisible();
	});

	test('an empty history window reads as no samples, not a fabricated line', async ({ page }) => {
		await mockDashboardApis(page, { historySamples: 0 });
		await page.goto(`/aq${SEED_HASH}`);

		await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
		await expect(page.getByText(/No hourly samples/i)).toBeVisible();
		await expect(page.getByRole('img', { name: /hourly history/i })).toHaveCount(0);
	});

	test('switching the history pollutant refetches', async ({ page }) => {
		await mockDashboardApis(page);
		await page.goto(`/aq${SEED_HASH}`);
		await expect(page.getByRole('img', { name: /hourly history/i })).toBeVisible();

		const o3Request = page.waitForRequest(
			(req) => req.url().includes('/api/atmospheric/openaq-history') && req.url().includes('param=o3'),
			{ timeout: 10_000 },
		);
		await page.getByRole('group', { name: 'Pollutant' }).getByRole('button', { name: 'O₃' }).click();
		await o3Request;
	});
});

test.describe('AQ dashboard deep-link from the map', () => {
	test('the readout CTA navigates to /aq seeded with the point', async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem('darkmap-tour-v1', '1'));
		await page.route('**/api/atmospheric/point*', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					matchedTime: '2026-05-30T12:00',
					pwv: null,
					rh: 55,
					cloudLow: 10,
					cloudMid: 5,
					cloudHigh: 0,
					visibility: 24000,
				}),
			}),
		);

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
		await page.mouse.click(640, 400);
		await page.waitForSelector('.readout[role=dialog]');

		const cta = page.getByRole('button', { name: /air-quality analysis dashboard for this point/i });
		await expect(cta).toBeVisible();
		await cta.click();
		await expect(page).toHaveURL(/\/aq#m=/);
	});
});
