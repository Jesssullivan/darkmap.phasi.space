import { expect, test } from '@playwright/test';

// Instrument interactions are independent of first-run onboarding. The tour's
// keyboard handler intentionally consumes Enter/Space while its dialog is open.
test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('darkmap-tour-v1', '1'));
});

test('right inspector owns Air and local dome while the viewport toolbar alone owns Twilight', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/');
	const instruments = page.locator('.deck-inspector .instrument-column');
	await expect(instruments).toBeVisible();
	await expect(page.locator('.instrument-column')).toHaveCount(1);
	await expect(instruments.locator('.tile')).toHaveCount(2);
	const instrumentBox = await instruments.boundingBox();
	const stageBox = await page.locator('.stage').boundingBox();
	expect(instrumentBox).not.toBeNull();
	expect(stageBox).not.toBeNull();
	expect(instrumentBox!.x).toBeGreaterThanOrEqual(stageBox!.x + stageBox!.width - 1);
	await expect(page.locator('.toolbar .tool[aria-label*="twilight strip"]')).toBeVisible();
	await expect(page.locator('.toolbar .tool[aria-label*="twilight strip"]')).toHaveCount(1);
	await expect(page.locator('.tools-cluster .tool-tile').filter({ hasText: /Twilight/i })).toHaveCount(0);
});

test('reduced motion preserves keyboard detach, stage restoration and focus', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/');
	const detach = page.getByRole('button', { name: 'Detach Air and local dome' });
	await detach.focus();
	await detach.press('Enter');
	const floating = page.locator('[data-instrument-panel="floating"]');
	await expect(floating).toBeVisible();
	await expect(floating.getByRole('heading', { name: 'Air · local dome' })).toBeFocused();
	const contrast = await floating.evaluate((panel) => {
		const luminance = (color: string) => {
			const channels = color
				.match(/[\d.]+/g)!
				.slice(0, 3)
				.map(Number)
				.map((value) => {
					const channel = value / 255;
					return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
				});
			return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
		};
		return ['.instrument-float-header', '.instrument-float-body'].map((selector) => {
			const style = getComputedStyle(panel.querySelector(selector)!);
			const foreground = luminance(style.color);
			const background = luminance(style.backgroundColor);
			return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
		});
	});
	for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(4.5);
	await page.getByRole('button', { name: 'Minimize instruments' }).click();
	await expect(floating.locator('.instrument-float-body')).toBeHidden();
	await expect(floating.getByRole('heading', { name: 'Air · local dome' })).toBeFocused();
	await page.getByRole('button', { name: 'Restore instruments' }).click();
	await expect(floating.locator('.instrument-float-body')).toBeVisible();
	await expect(floating.getByRole('heading', { name: 'Air · local dome' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(floating).toHaveCount(0);
	await expect(detach).toBeFocused();
});

test('compact keeps the Air instrument in the readout dock', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/#lens=air');
	await expect(page.locator('[data-responsive-dock] .instrument-column.compact')).toBeVisible();
	await expect(page.locator('[data-instrument-panel="docked"]')).toHaveCount(0);
	await expect(page.locator('.instrument-column')).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Detach Air and local dome' })).toHaveCount(0);
});

test('medium inspector keeps docked instruments reachable through its tab', async ({ page }) => {
	await page.setViewportSize({ width: 768, height: 900 });
	await page.goto('/');
	const panel = page.locator('[data-instrument-panel="docked"]');
	const inspectorTab = page.getByRole('button', { name: 'Collapse inspector' });
	await expect(panel).toBeVisible();
	await expect(page.getByRole('button', { name: 'Detach Air and local dome' })).toHaveCount(0);
	await inspectorTab.click();
	await expect(panel).toBeHidden();
	await page.getByRole('button', { name: 'Expand inspector' }).click();
	await expect(panel).toBeVisible();
});

test('1024–1279px keeps the inspector panel docked without a detach control', async ({ page }) => {
	await page.setViewportSize({ width: 1180, height: 800 });
	await page.goto('/');
	await expect(page.locator('[data-instrument-panel="docked"]')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Detach Air and local dome' })).toHaveCount(0);
});

test('wide instruments detach once, redock, and return keyboard focus', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/');
	const docked = page.locator('[data-instrument-panel="docked"]');
	const floating = page.locator('[data-instrument-panel="floating"]');
	const detach = page.getByRole('button', { name: 'Detach Air and local dome' });
	await expect(docked).toBeVisible();
	await detach.click();
	await expect(floating).toBeVisible();
	await expect(docked).toHaveCount(0);
	await expect(page.locator('.instrument-column')).toHaveCount(1);
	await expect(floating.getByRole('heading', { name: 'Air · local dome' })).toBeFocused();
	await page.getByRole('button', { name: 'Redock instruments' }).click();
	await expect(docked).toBeVisible();
	await expect(floating).toHaveCount(0);
	await expect(detach).toBeFocused();
	await detach.click();
	await expect(floating).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(docked).toBeVisible();
	await expect(detach).toBeFocused();
	await detach.press('Enter');
	await expect(floating).toBeVisible();
	await page.getByRole('button', { name: 'Redock instruments' }).click();
	await detach.press('Space');
	await expect(floating).toBeVisible();
});

test('floating panel minimizes to its header, restores, and stays within the viewport when dragged', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/');
	await page.getByRole('button', { name: 'Detach Air and local dome' }).click();
	const floating = page.locator('[data-instrument-panel="floating"]');
	const initial = await floating.boundingBox();
	expect(initial).not.toBeNull();
	await page.getByRole('button', { name: 'Minimize instruments' }).click();
	await expect(floating.locator('.instrument-float-body')).toBeHidden();
	const minimized = await floating.boundingBox();
	expect(minimized).not.toBeNull();
	expect(minimized!.height).toBeLessThan(initial!.height);
	await page.getByRole('button', { name: 'Restore instruments' }).click();
	await expect(floating.locator('.instrument-float-body')).toBeVisible();
	const drag = floating.locator('.instrument-float-drag');
	const dragBox = await drag.boundingBox();
	expect(dragBox).not.toBeNull();
	const beforeDrag = await floating.boundingBox();
	expect(beforeDrag).not.toBeNull();
	await page.mouse.move(dragBox!.x + 30, dragBox!.y + dragBox!.height / 2);
	await page.mouse.down();
	await page.mouse.move(4000, 4000, { steps: 8 });
	await page.mouse.up();
	await expect
		.poll(async () => {
			const box = await floating.boundingBox();
			return box ? Math.hypot(box.x - beforeDrag!.x, box.y - beforeDrag!.y) : 0;
		})
		.toBeGreaterThan(1);
	const bounded = await floating.boundingBox();
	expect(bounded).not.toBeNull();
	expect(bounded!.x).toBeGreaterThanOrEqual(-1);
	expect(bounded!.y).toBeGreaterThanOrEqual(-1);
	expect(bounded!.x + bounded!.width).toBeLessThanOrEqual(1441);
	expect(bounded!.y + bounded!.height).toBeLessThanOrEqual(901);
});

test('wide-to-phone resize redocks without stranding focus in a hidden panel', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/');
	await page.getByRole('button', { name: 'Detach Air and local dome' }).click();
	await expect(page.locator('[data-instrument-panel="floating"]')).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.locator('[data-instrument-panel="floating"]')).toHaveCount(0);
	await expect(page.locator('[data-responsive-dock] .instrument-column.compact')).toBeVisible();
	await expect(page.locator('[data-responsive-dock] .dock-tab:focus')).toHaveCount(1);
});

test('short wide viewport does not offer a panel that cannot fit', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 450 });
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Detach Air and local dome' })).toHaveCount(0);
	await expect(page.locator('[data-instrument-panel="floating"]')).toHaveCount(0);
});

for (const viewport of [
	{ width: 568, height: 320 },
	{ width: 1440, height: 450 },
]) {
	test(`short ${viewport.width}px keeps Air reachable through native keyboard disclosure`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await page.goto('/#lens=air');
		const disclosure = page.locator('[data-short-air]');
		const summary = disclosure.locator('summary');
		await expect(summary).toBeVisible();
		await summary.focus();
		await summary.press('Enter');
		const air = disclosure.getByRole('region', { name: 'Air — viewport air quality' });
		await expect(air).toBeVisible();
		await expect(page.locator('.instrument-column')).toHaveCount(1);
		await expect(air.locator('.aqi-value')).toHaveText(/\S+/);
		await expect(disclosure.locator('.sky-tile')).toHaveCount(0);
		const bounds = await disclosure.boundingBox();
		expect(bounds).not.toBeNull();
		expect(bounds!.y).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
		expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
		await summary.press('Space');
		await expect(air).toBeHidden();
		await expect(summary).toBeFocused();
	});
}

test('wide floating instruments resize, maximize, restore and redock when height becomes short', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/');
	await page.getByRole('button', { name: 'Detach Air and local dome' }).click();
	const floating = page.locator('[data-instrument-panel="floating"]');
	const initial = await floating.boundingBox();
	expect(initial).not.toBeNull();
	const grip = await page.getByLabel('Resize instruments').boundingBox();
	expect(grip).not.toBeNull();
	await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
	await page.mouse.down();
	await page.mouse.move(grip!.x + 80, grip!.y + 70, { steps: 8 });
	await page.mouse.up();
	await expect.poll(async () => (await floating.boundingBox())?.width ?? 0).toBeGreaterThan(initial!.width);
	const resized = await floating.boundingBox();
	expect(resized).not.toBeNull();
	await page.getByRole('button', { name: 'Maximize instruments' }).click();
	await expect(floating.locator('.instrument-float-body')).toBeVisible();
	await expect
		.poll(async () => {
			const box = await floating.boundingBox();
			return box ? box.width * box.height : 0;
		})
		.toBeGreaterThan(resized!.width * resized!.height + 1);
	await page.getByRole('button', { name: 'Restore instruments' }).click();
	await expect(floating.locator('.instrument-float-body')).toBeVisible();
	await expect
		.poll(async () => {
			const box = await floating.boundingBox();
			return box
				? Math.max(Math.abs(box.width - resized!.width), Math.abs(box.height - resized!.height))
				: Number.POSITIVE_INFINITY;
		})
		.toBeLessThanOrEqual(1);
	await page.setViewportSize({ width: 1440, height: 450 });
	await expect(floating).toHaveCount(0);
	await expect(page.locator('[data-short-air] summary')).toBeFocused();
	await expect(page.getByRole('button', { name: 'Detach Air and local dome' })).toHaveCount(0);
});
