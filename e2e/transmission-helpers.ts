import { expect, type Locator, type Page } from '@playwright/test';

/**
 * V3 — the spectral-transmission sheet is point-anchored: it opens from the
 * PointReadout for the currently selected map point (the old independent
 * LayerRail CTA / per-row (i) entry points were removed). These specs care
 * about the SHEET, not the atmospheric data pipeline, so we stub
 * `/api/atmospheric/point` with a fixed reading — that guarantees the readout's
 * "Spectral transmission T(λ)" CTA renders (it is gated on `data.atmospheric`)
 * regardless of upstream Open-Meteo availability. The unmocked data-flow guard
 * lives in `atmospheric-render.spec.ts`.
 */
export interface OpenSheetOptions {
	readonly width?: number;
	readonly height?: number;
	/** Wait for the `/spectral-lut.json` fetch the sheet kicks off on open. */
	readonly waitForLut?: boolean;
}

/** A deterministic atmospheric point reading matching the `/api/atmospheric/point` contract. */
const STUB_ATMOSPHERIC = {
	matchedTime: '2026-05-30T12:00',
	pwv: null,
	rh: 55,
	cloudLow: 10,
	cloudMid: 5,
	cloudHigh: 0,
	visibility: 24000,
};

/**
 * Drive the full point-anchored entry flow: stub the atmospheric reading,
 * load the app, click the map to drop a readout, then open the spectral
 * sheet from the readout's CTA. Returns the sheet dialog locator.
 */
export async function openTransmissionSheet(page: Page, opts: OpenSheetOptions = {}): Promise<Locator> {
	const { width = 1280, height = 800, waitForLut = false } = opts;

	// Suppress the first-run tour so it can't cover the map / readout.
	await page.addInitScript(() => localStorage.setItem('darkmap-tour-v1', '1'));
	await page.route('**/api/atmospheric/point*', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STUB_ATMOSPHERIC) }),
	);

	await page.setViewportSize({ width, height });
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	// The map click handler is registered on map load; the canvas being present
	// is the proxy other specs use for "map is interactive".
	await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();

	// Click the map centre to pin a point and surface the readout.
	await page.mouse.click(Math.floor(width / 2), Math.floor(height / 2));
	await page.waitForSelector('.readout[role=dialog]');

	const cta = page.getByRole('button', { name: /Open spectral transmission analysis for this point/i });
	await expect(cta).toBeVisible();

	const lut = waitForLut
		? page.waitForRequest((req) => req.url().includes('/spectral-lut.json'), { timeout: 15_000 })
		: null;
	await cta.click();
	if (lut) await lut;

	return page.getByRole('dialog', { name: /Atmospheric transmission/i });
}
