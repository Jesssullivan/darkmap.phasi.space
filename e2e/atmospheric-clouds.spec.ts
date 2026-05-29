import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

// PR-B: MODIS Terra clouds — first NASA GIBS atmospheric overlay. The toggle
// lives in the LayerRail; flipping it on should kick MapLibre to fetch tiles
// through `/api/raster?layer=clouds-modis-terra&kind=atmospheric&...`, which
// the service worker buckets into `darkmap-atmospheric-tile`. The e2e asserts
// the proxy contract — if the network shape is right, both the MapLibre
// `addSource` call and the SW bucket attribution follow for free.

// Extended in PR-D to cover the rest of the GIBS overlays. Each row in
// `EXTRA_LAYERS` re-runs the same proxy-contract check (the toggle fires a
// `/api/raster?layer=...&kind=atmospheric` request) so the LayerRail + proxy
// integration is exercised for every atmospheric layer.
const EXTRA_LAYERS: ReadonlyArray<{
	readonly id: string;
	readonly label: RegExp;
	readonly mapHash: string;
	readonly maxNativeZoom: number;
}> = [
	{ id: 'clouds-viirs-noaa20', label: /Clouds \(VIIRS NOAA-20\)/i, mapHash: '/#m=44,-73,12', maxNativeZoom: 9 },
	{ id: 'aerosol-modis-aod', label: /Aerosol AOD \(MODIS\)/i, mapHash: '/#m=36,-115,12', maxNativeZoom: 6 },
	{ id: 'water-vapor-airs', label: /Water vapor \(MODIS Terra\)/i, mapHash: '/#m=38,-122,12', maxNativeZoom: 6 },
];

const TRANSPARENT_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
	'base64',
);

const openAtmosphereRail = async (page: Page): Promise<void> => {
	const drawerToggle = page.getByRole('button', { name: /Open layers/i });
	if (await drawerToggle.isVisible()) await drawerToggle.click();
	const atmosphereHeader = page.getByRole('button', { name: /Atmosphere/i });
	await expect(atmosphereHeader).toBeVisible();
	const expanded = await atmosphereHeader.getAttribute('aria-expanded');
	if (expanded !== 'true') await atmosphereHeader.click();
};

const mockAtmosphericLayerTiles = async (
	page: Page,
	opts: {
		readonly layerId: string;
		readonly status: number;
		readonly outcome?: 'ok' | 'no-data';
	},
): Promise<void> => {
	await page.route('**/api/raster?**', async (route) => {
		const url = new URL(route.request().url());
		if (url.searchParams.get('layer') !== opts.layerId || url.searchParams.get('kind') !== 'atmospheric') {
			await route.continue();
			return;
		}

		const headers: Record<string, string> = {};
		if (opts.outcome) headers['x-darkmap-atmospheric-outcome'] = opts.outcome;

		if (opts.status >= 200 && opts.status < 300) {
			await route.fulfill({
				status: opts.status,
				headers: { ...headers, 'content-type': 'image/png' },
				body: TRANSPARENT_PNG,
			});
			return;
		}

		await route.fulfill({
			status: opts.status,
			headers: { ...headers, 'content-type': 'text/plain' },
			body: `upstream ${opts.status}`,
		});
	});
};

const atmosphericRow = (page: Page, label: RegExp) =>
	page.locator('li').filter({ has: page.getByRole('checkbox', { name: label }) });

for (const { id, label, mapHash, maxNativeZoom } of EXTRA_LAYERS) {
	test(`Atmospheric layer ${id}: toggle fires the proxy with kind=atmospheric`, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await mockAtmosphericLayerTiles(page, { layerId: id, status: 200, outcome: 'ok' });
		await page.goto(mapHash);
		await page.waitForLoadState('networkidle');
		await openAtmosphereRail(page);

		const toggle = page.getByRole('checkbox', { name: label });
		await expect(toggle).toBeVisible();
		await expect(toggle).not.toBeChecked();
		const proxyRequest = page.waitForRequest(
			(req) =>
				req.url().includes('/api/raster') &&
				req.url().includes(`layer=${id}`) &&
				req.url().includes('kind=atmospheric'),
			{ timeout: 15_000 },
		);
		await toggle.check();

		const req = await proxyRequest;
		const url = new URL(req.url());
		expect(url.searchParams.get('layer')).toBe(id);
		expect(url.searchParams.get('kind')).toBe('atmospheric');
		expect(url.searchParams.get('time')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(Number(url.searchParams.get('z'))).toBeLessThanOrEqual(maxNativeZoom);
	});
}

test.describe('Atmospheric layer health pills', () => {
	test('transparent no-data tiles surface as no data in the LayerRail', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await mockAtmosphericLayerTiles(page, { layerId: 'water-vapor-airs', status: 200, outcome: 'no-data' });

		await page.goto('/#m=38,-122,12');
		await page.waitForLoadState('networkidle');
		await openAtmosphereRail(page);

		const waterVaporToggle = page.getByRole('checkbox', { name: /Water vapor \(MODIS Terra\)/i });
		await expect(waterVaporToggle).toBeVisible();
		await waterVaporToggle.check();

		const row = atmosphericRow(page, /Water vapor \(MODIS Terra\)/i);
		await expect(row.getByText('no data', { exact: true })).toBeVisible();
		await expect(row.getByText('live', { exact: true })).toHaveCount(0);
	});

	test('upstream failures surface status-specific errors in the LayerRail', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await mockAtmosphericLayerTiles(page, { layerId: 'aerosol-modis-aod', status: 502 });

		await page.goto('/#m=36,-115,12');
		await page.waitForLoadState('networkidle');
		await openAtmosphereRail(page);

		const aerosolToggle = page.getByRole('checkbox', { name: /Aerosol AOD \(MODIS\)/i });
		await expect(aerosolToggle).toBeVisible();
		await aerosolToggle.check();

		const row = atmosphericRow(page, /Aerosol AOD \(MODIS\)/i);
		await expect(row.getByText('error 502', { exact: true })).toBeVisible();
	});
});

test.describe('Atmospheric layer: MODIS Terra clouds', () => {
	test('toggling the layer triggers a proxied GIBS tile fetch with kind=atmospheric', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await mockAtmosphericLayerTiles(page, { layerId: 'clouds-modis-terra', status: 200, outcome: 'ok' });

		await page.goto('/');
		await page.waitForLoadState('networkidle');
		await openAtmosphereRail(page);

		// LayerRail exposes one toggle per layer with `aria-label="{label} toggle"`.
		const cloudsToggle = page.getByRole('checkbox', { name: /Clouds \(MODIS Terra\)/i });
		await expect(cloudsToggle).toBeVisible();
		await expect(cloudsToggle).not.toBeChecked();
		const atmosphericTileRequest = page.waitForRequest(
			(req) =>
				req.url().includes('/api/raster') &&
				req.url().includes('layer=clouds-modis-terra') &&
				req.url().includes('kind=atmospheric'),
			{ timeout: 15_000 },
		);
		await cloudsToggle.check();
		await expect(cloudsToggle).toBeChecked();

		const req = await atmosphericTileRequest;
		const url = new URL(req.url());
		expect(url.searchParams.get('layer')).toBe('clouds-modis-terra');
		expect(url.searchParams.get('kind')).toBe('atmospheric');
		expect(url.searchParams.get('time')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(url.searchParams.get('z')).toMatch(/^\d+$/);
		expect(Number(url.searchParams.get('z'))).toBeLessThanOrEqual(9);
	});

	test('tiles use the ephemeris UTC day and remount when the day changes', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await mockAtmosphericLayerTiles(page, { layerId: 'clouds-modis-terra', status: 200, outcome: 'ok' });

		await page.goto('/#m=42.4434,-76.5019,9&et=2026-05-28T23:50Z');
		await page.waitForLoadState('networkidle');
		await openAtmosphereRail(page);

		const cloudsToggle = page.getByRole('checkbox', { name: /Clouds \(MODIS Terra\)/i });
		const initialDayRequest = page.waitForRequest(
			(req) =>
				req.url().includes('/api/raster') &&
				req.url().includes('layer=clouds-modis-terra') &&
				req.url().includes('kind=atmospheric') &&
				req.url().includes('time=2026-05-28'),
			{ timeout: 15_000 },
		);
		await cloudsToggle.check();
		expect(new URL((await initialDayRequest).url()).searchParams.get('time')).toBe('2026-05-28');

		const nextDayRequest = page.waitForRequest(
			(req) =>
				req.url().includes('/api/raster') &&
				req.url().includes('layer=clouds-modis-terra') &&
				req.url().includes('kind=atmospheric') &&
				req.url().includes('time=2026-05-29'),
			{ timeout: 15_000 },
		);
		await page.getByRole('slider', { name: /Time scrubber/i }).focus();
		await page.keyboard.press('ArrowRight');
		expect(new URL((await nextDayRequest).url()).searchParams.get('time')).toBe('2026-05-29');
	});

	test('high-zoom map overzooms atmospheric layers instead of requesting unsupported GIBS matrix tiles', async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await mockAtmosphericLayerTiles(page, { layerId: 'water-vapor-airs', status: 200, outcome: 'ok' });

		await page.goto('/#m=42.4434,-76.5019,12');
		await page.waitForLoadState('networkidle');
		await openAtmosphereRail(page);

		const waterVaporToggle = page.getByRole('checkbox', { name: /Water vapor \(MODIS Terra\)/i });
		await expect(waterVaporToggle).toBeVisible();
		const atmosphericTileRequest = page.waitForRequest(
			(req) =>
				req.url().includes('/api/raster') &&
				req.url().includes('layer=water-vapor-airs') &&
				req.url().includes('kind=atmospheric'),
			{ timeout: 15_000 },
		);
		await waterVaporToggle.check();

		const req = await atmosphericTileRequest;
		const url = new URL(req.url());
		expect(Number(url.searchParams.get('z'))).toBeLessThanOrEqual(6);
	});

	test('toggling off re-checks to false; opacity slider becomes interactive when on', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		await openAtmosphereRail(page);

		const cloudsToggle = page.getByRole('checkbox', { name: /Clouds \(MODIS Terra\)/i });
		await cloudsToggle.check();
		await expect(cloudsToggle).toBeChecked();

		const opacitySlider = page.getByRole('slider', { name: /Clouds \(MODIS Terra\) opacity/i });
		await expect(opacitySlider).toBeEnabled();

		await cloudsToggle.uncheck();
		await expect(cloudsToggle).not.toBeChecked();
		await expect(opacitySlider).toHaveCount(0);
	});
});
