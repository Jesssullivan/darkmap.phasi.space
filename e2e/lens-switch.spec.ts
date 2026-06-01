import { expect, test, type Page } from '@playwright/test';

// S1 PR2 — the persona-lens switcher. Asserts the chips + number keys 1–4 swap
// the active lens, the `&lens=` hash segment tracks it (sky default omitted),
// the map view (`m=`) is preserved across every switch, and every chip stays
// visible + enabled regardless of the active lens (never-gate). Mobile (≤820px)
// folds the labels away but keeps each chip named for assistive tech.

/** Read a single `key=value` segment out of the URL hash (null when absent). */
async function hashSeg(page: Page, key: string): Promise<string | null> {
	const h = await page.evaluate(() => window.location.hash);
	const m = new RegExp(`(?:^#|&)${key}=([^&]*)`).exec(h);
	return m ? m[1] : null;
}

// scheduleHashWrite is debounced 250ms; give it margin before reading the hash.
const HASH_SETTLE = 350;

test.describe('Lens switcher (S1)', () => {
	test('chips + number keys swap the lens; map view preserved; never gated', async ({ page }) => {
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const nav = page.getByRole('navigation', { name: 'Map lens' });
		await expect(nav).toBeVisible();
		const sky = nav.getByRole('button', { name: 'Sky' });
		const air = nav.getByRole('button', { name: 'Air' });
		const links = nav.getByRole('button', { name: 'Links' });
		const orbit = nav.getByRole('button', { name: 'Orbit' });

		// Cold start defaults to Sky, and the default is omitted from the hash.
		await expect(sky).toHaveAttribute('aria-pressed', 'true');

		// Click Air → active toggles, hash gains lens=air, map view captured.
		await air.click();
		await expect(air).toHaveAttribute('aria-pressed', 'true');
		await expect(sky).toHaveAttribute('aria-pressed', 'false');
		await page.waitForTimeout(HASH_SETTLE);
		expect(await hashSeg(page, 'lens')).toBe('air');
		const mapView = await hashSeg(page, 'm');
		expect(mapView).not.toBeNull(); // scheduleHashWrite serializes the live view

		// Number key 3 → Links (keyboard accelerator), map view unchanged.
		await page.keyboard.press('3');
		await expect(links).toHaveAttribute('aria-pressed', 'true');
		await page.waitForTimeout(HASH_SETTLE);
		expect(await hashSeg(page, 'lens')).toBe('links');
		expect(await hashSeg(page, 'm')).toBe(mapView);

		// Number key 4 → Orbit.
		await page.keyboard.press('4');
		await expect(orbit).toHaveAttribute('aria-pressed', 'true');
		await page.waitForTimeout(HASH_SETTLE);
		expect(await hashSeg(page, 'lens')).toBe('orbit');

		// Number key 1 → back to Sky → the default drops out of the hash again.
		await page.keyboard.press('1');
		await expect(sky).toHaveAttribute('aria-pressed', 'true');
		await page.waitForTimeout(HASH_SETTLE);
		expect(await hashSeg(page, 'lens')).toBeNull();
		expect(await hashSeg(page, 'm')).toBe(mapView); // map never moved

		// Never-gate: every chip stays visible + enabled in every lens.
		for (const chip of [sky, air, links, orbit]) {
			await expect(chip).toBeVisible();
			await expect(chip).toBeEnabled();
			await expect(chip).not.toHaveAttribute('aria-disabled', 'true');
		}
	});

	test('a shared #lens= link restores the active lens on load', async ({ page }) => {
		await page.goto('/#m=42.44,-76.5,9&lens=links');
		await page.waitForLoadState('networkidle');

		const nav = page.getByRole('navigation', { name: 'Map lens' });
		await expect(nav.getByRole('button', { name: 'Links' })).toHaveAttribute('aria-pressed', 'true');
		await expect(nav.getByRole('button', { name: 'Sky' })).toHaveAttribute('aria-pressed', 'false');
	});

	test('mobile (≤820px): compact switcher still swaps the lens, chips stay named', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14
		await page.goto('/');
		await page.waitForLoadState('networkidle');

		const nav = page.getByRole('navigation', { name: 'Map lens' });
		// Labels are visually hidden at this width, but aria-label keeps the
		// chips reachable by accessible name.
		const orbit = nav.getByRole('button', { name: 'Orbit' });
		await expect(orbit).toBeVisible();
		await orbit.click();
		await expect(orbit).toHaveAttribute('aria-pressed', 'true');
		await page.waitForTimeout(HASH_SETTLE);
		expect(await hashSeg(page, 'lens')).toBe('orbit');

		// Lens switch must not blank the map.
		await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
	});
});
